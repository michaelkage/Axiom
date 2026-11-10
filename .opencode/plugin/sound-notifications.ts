import type { Plugin } from "@opencode-ai/plugin";

export const SoundNotifications: Plugin = async ({ $ }) => {
	const ringTerminalBell = async () => {
		try {
			await import type { Plugin } from "@opencode-ai/plugin";

tput bel`;
		} catch {
			// Headless environments and terminals without terminfo cannot ring a bell.
		}
	};

	return {
		event: async ({ event }) => {
			if (event.type === "permission.updated") {
				// Play Ping sound for permission requests
				// await $`afplay /System/Library/Sounds/Ping.aiff`;
				await ringTerminalBell();
			}

			if (event.type === "session.idle") {
				// Play Submarine sound when agent finishes
				// await $`afplay /System/Library/Sounds/Submarine.aiff`;
				await ringTerminalBell();
			}
		},
	};
};
