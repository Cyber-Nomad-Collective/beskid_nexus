import { execFileSync } from "node:child_process";

export function hasRelevantWorkingTreeChanges(repoPath: string): boolean {
	try {
		const out = execFileSync(
			"git",
			[
				"status",
				"--porcelain",
				"--",
				".",
				":(exclude).gitnexus",
				":(exclude).gitnexus/**",
				":(exclude).claude",
				":(exclude).claude/**",
				":(exclude).cursor",
				":(exclude).cursor/**",
				":(exclude)AGENTS.md",
				":(exclude)CLAUDE.md",
			],
			{
				cwd: repoPath,
				stdio: ["ignore", "pipe", "ignore"],
				encoding: "utf8",
			},
		);
		return out.trim().length > 0;
	} catch {
		return true; // conservative on git failure
	}
}
