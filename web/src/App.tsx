import { Button } from "@/components/arc/button/button";

export function App() {
	return (
		<main className="shell">
			<p className="eyebrow">omp-broker</p>
			<h1>Gateway control surface</h1>
			<p className="lede">
				The frontend scaffold is wired to the Arc registry. Replace this page with the real console.
			</p>
			<div className="actions">
				<Button>Save changes</Button>
				<Button variant="secondary">View logs</Button>
			</div>
		</main>
	);
}
