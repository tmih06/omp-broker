import { useEffect, useRef, useState } from "react";

/** Flips once when the element first crosses into view; used to grow bars in. */
export function useSeen<T extends HTMLElement>(threshold = 0.18) {
	const ref = useRef<T | null>(null);
	const [seen, setSeen] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el || seen) return;
		if (typeof IntersectionObserver === "undefined") {
			setSeen(true);
			return;
		}
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				setSeen(true);
				observer.disconnect();
			},
			{ threshold },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [seen, threshold]);

	return { ref, seen };
}
