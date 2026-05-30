import { BeskidHub } from '@beskid/beskid-ui/react/BeskidHub';
import { type ReactNode, useState } from 'react';

import { ThemeToggle } from './theme-toggle';
import { ConnectMcpDialog } from './connect-mcp-dialog';
import { Button } from '#/components/ui/button';
import { Separator } from '#/components/ui/separator';
import type { AuthUser } from '../services/nexus-api';

export interface NexusAppShellProps {
	repoName?: string;
	repoSelector?: ReactNode;
	search?: ReactNode;
	actions?: ReactNode;
	authUser?: AuthUser | null;
	children: ReactNode;
}

export function NexusAppShell({
	repoName,
	repoSelector,
	search,
	actions,
	authUser,
	children,
}: NexusAppShellProps) {
	const [mcpOpen, setMcpOpen] = useState(false);
	const mcpUrl = `${window.location.origin}/api/mcp`;

	return (
		<div className="flex h-screen flex-col overflow-hidden bg-background">
			<header className="flex h-14 shrink-0 items-center border-b border-border px-4">
				<div className="flex min-w-0 items-center gap-2">
					<p className="nexus-kicker hidden shrink-0 sm:block">Beskid</p>
					<span className="text-muted-foreground hidden sm:inline">/</span>
					<span className="hidden truncate font-semibold md:inline">Nexus</span>
					{repoName ? (
						<>
							<span className="text-muted-foreground hidden md:inline">/</span>
							<span className="hidden truncate text-sm text-muted-foreground md:inline">
								{repoName}
							</span>
						</>
					) : null}
					{repoSelector ? (
						<>
							<Separator orientation="vertical" className="mx-1 hidden h-6 sm:block" />
							{repoSelector}
						</>
					) : null}
				</div>

				<div className="ml-auto flex min-w-0 max-w-2xl flex-1 items-center justify-end gap-2">
					{search}
					{actions}
					{authUser ? (
						<>
							<Button type="button" variant="outline" size="sm" onClick={() => setMcpOpen(true)}>
								Connect MCP
							</Button>
							<ConnectMcpDialog open={mcpOpen} onOpenChange={setMcpOpen} mcpUrl={mcpUrl} />
						</>
					) : null}
					<ThemeToggle />
					<BeskidHub />
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col">{children}</div>
		</div>
	);
}
