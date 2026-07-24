import { BeskidHub } from "@beskid/beskid-ui/react/BeskidHub";
import { type ReactNode, useState } from "react";
import { Button } from "#/components/ui/button";
import type { AuthUser } from "../services/nexus-api";
import { ConnectMcpDialog } from "./connect-mcp-dialog";
import {
	NexusSettingsDialog,
	NexusSettingsHeaderButton,
} from "./nexus-settings-dialog";
import { ThemeToggle } from "./theme-toggle";

export interface NexusAppShellProps {
	repoSelector?: ReactNode;
	search?: ReactNode;
	actions?: ReactNode;
	authUser?: AuthUser | null;
	onCatalogChanged?: () => void;
	children: ReactNode;
}

export function NexusAppShell({
	repoSelector,
	search,
	actions,
	authUser,
	onCatalogChanged,
	children,
}: NexusAppShellProps) {
	const [mcpOpen, setMcpOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const mcpUrl = `${window.location.origin}/api/mcp`;

	return (
		<div className="flex h-screen flex-col overflow-hidden bg-background">
			<header className="flex h-14 shrink-0 items-center bg-card/50 px-4">
				<div className="flex min-w-0 items-center gap-1.5">
					<p className="nexus-kicker hidden shrink-0 sm:block">Beskid</p>
					<span className="text-muted-foreground hidden sm:inline">/</span>
					<span className="hidden truncate font-semibold md:inline">Nexus</span>
					{repoSelector ? (
						<>
							<span className="text-muted-foreground hidden md:inline">/</span>
							{repoSelector}
						</>
					) : null}
				</div>

				<div className="ml-auto flex min-w-0 max-w-2xl flex-1 items-center justify-end gap-2">
					{search}
					{actions}
					{authUser?.isAdmin ? (
						<NexusSettingsHeaderButton
							open={settingsOpen}
							onOpenChange={setSettingsOpen}
						/>
					) : null}
					{authUser ? (
						<>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setMcpOpen(true)}
							>
								Connect MCP
							</Button>
							<ConnectMcpDialog
								open={mcpOpen}
								onOpenChange={setMcpOpen}
								mcpUrl={mcpUrl}
							/>
						</>
					) : null}
					<ThemeToggle />
					<BeskidHub />
				</div>
			</header>

			<NexusSettingsDialog
				open={settingsOpen}
				onOpenChange={setSettingsOpen}
				authUser={authUser ?? null}
				onCatalogChanged={onCatalogChanged}
			/>

			<div className="flex min-h-0 flex-1 flex-col">{children}</div>
		</div>
	);
}
