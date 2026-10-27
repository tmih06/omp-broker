import * as readline from "node:readline/promises";

export interface AskOptions {
	secret?: boolean;
	allowEmpty?: boolean;
	placeholder?: string;
	signal?: AbortSignal;
}

/**
 * Line reader for terminal prompts. TTY input uses raw mode so secret prompts
 * can be masked; piped input falls back to readline. Only one prompt is active
 * at a time, and `close()` restores the terminal if the OAuth flow finished
 * while a manual-code prompt was still waiting.
 */
export class Prompter {
	#pending:
		| {
				reject: (error: Error) => void;
		  }
		| undefined;

	async ask(message: string, options: AskOptions = {}): Promise<string> {
		const label = `${message}${options.placeholder ? ` (${options.placeholder})` : ""} `;
		for (;;) {
			const value = process.stdin.isTTY
				? await this.#askRaw(label, options)
				: await this.#askPipe(label, options.signal);
			if (value.length > 0 || options.allowEmpty) return value;
		}
	}

	#askPipe(label: string, signal?: AbortSignal): Promise<string> {
		process.stdout.write(label);
		const rl = readline.createInterface({ input: process.stdin });
		const question = rl.question("");
		const aborted = Promise.withResolvers<string>();
		const onAbort = () => aborted.reject(new Error("OAuth login cancelled"));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return Promise.race([question, aborted.promise]).finally(() => {
			signal?.removeEventListener("abort", onAbort);
			rl.close();
		});
	}

	#askRaw(label: string, options: AskOptions): Promise<string> {
		process.stdout.write(label);
		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let value = "";
		let onAbort = () => {};
		const finish = (result: string | Error) => {
			stdin.off("data", onData);
			options.signal?.removeEventListener("abort", onAbort);
			stdin.setRawMode(false);
			stdin.pause();
			this.#pending = undefined;
			if (result instanceof Error) reject(result);
			else resolve(result);
		};
		onAbort = () => finish(new Error("OAuth login cancelled"));
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					process.stdout.write("\n");
					finish(value);
					return;
				}
				if (char === "\u0003") {
					process.stdout.write("\n");
					finish(new Error("OAuth login cancelled"));
					return;
				}
				if (char === "\u007f" || char === "\b") {
					if (value.length > 0) {
						value = value.slice(0, -1);
						if (options.secret) process.stdout.write("\b \b");
					}
					continue;
				}
				if (char < " ") continue;
				value += char;
				process.stdout.write(options.secret ? "*" : char);
			}
		};
		this.#pending = { reject: finish };
		if (options.signal?.aborted) {
			onAbort();
			return promise;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		stdin.on("data", onData);
		return promise;
	}

	close(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
			process.stdin.pause();
		}
		pending.reject(new Error("OAuth login finished"));
	}
}
