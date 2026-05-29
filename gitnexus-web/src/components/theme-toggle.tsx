import { Moon, Sun } from '@/lib/lucide-icons';
import { Button } from '@beskid/ui-react';
import { useTheme } from 'next-themes';

export function ThemeToggle() {
	const { theme, setTheme, resolvedTheme } = useTheme();
	const isDark = (resolvedTheme ?? theme) !== 'light';

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className="size-8 shrink-0"
			title={isDark ? 'Light mode' : 'Dark mode'}
			aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
			onClick={() => setTheme(isDark ? 'light' : 'dark')}
		>
			{isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
		</Button>
	);
}
