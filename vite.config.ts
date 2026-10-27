import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		// Match the existing tab-indented, 120-column style so adopting the
		// formatter does not rewrite unrelated code.
		useTabs: true,
		tabWidth: 2,
		printWidth: 120,
		arrowParens: "avoid",
		sortPackageJson: false,
		// Agent skill assets are maintained by their own tooling; they are not
		// application code.
		ignorePatterns: [".agents/**", "skills-lock.json"],
		overrides: [
			{
				// Keep manifest indentation stable; Bun and Dependabot rewrite
				// package.json with two spaces.
				files: ["**/*.json"],
				options: { useTabs: false, tabWidth: 2 },
			},
			{
				// Documentation code samples stay space-indented.
				files: ["**/*.md"],
				options: { useTabs: false, tabWidth: 2 },
			},
		],
	},
	lint: {
		ignorePatterns: [".agents/**", "skills-lock.json"],
	},
});
