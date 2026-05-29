import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

interface ThemeProviderProps {
	children: ReactNode;
}

/** Uses `data-theme` like beskid-lang.org / tracker (not class-only `.dark`). */
export function ThemeProvider({ children }: ThemeProviderProps) {
	return (
		<NextThemesProvider
			attribute="data-theme"
			defaultTheme="dark"
			enableSystem
			disableTransitionOnChange
		>
			{children}
		</NextThemesProvider>
	);
}
