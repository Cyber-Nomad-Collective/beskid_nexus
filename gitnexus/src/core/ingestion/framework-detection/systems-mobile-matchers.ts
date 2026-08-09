import type {
	FrameworkHint,
	PathFrameworkContext,
} from "./contracts.js";

export function detectSystemsFramework(
	context: PathFrameworkContext,
): FrameworkHint | null {
	const { p } = context;
	// ========== GO FRAMEWORKS ==========

	// Go handlers
	if (
		(p.includes("/handlers/") || p.includes("/handler/")) &&
		p.endsWith(".go")
	) {
		return {
			framework: "go-http",
			entryPointMultiplier: 2.5,
			reason: "go-handlers",
		};
	}

	// Go routes
	if (p.includes("/routes/") && p.endsWith(".go")) {
		return {
			framework: "go-http",
			entryPointMultiplier: 2.5,
			reason: "go-routes",
		};
	}

	// Go controllers
	if (p.includes("/controllers/") && p.endsWith(".go")) {
		return {
			framework: "go-mvc",
			entryPointMultiplier: 2.5,
			reason: "go-controller",
		};
	}

	// Go main.go files (THE entry point) — only match main.go, not arbitrary .go files under cmd/
	if (p.endsWith("/main.go")) {
		return { framework: "go", entryPointMultiplier: 3.0, reason: "go-main" };
	}

	// ========== RUST FRAMEWORKS ==========

	// Rust handlers/routes
	if (
		(p.includes("/handlers/") || p.includes("/routes/")) &&
		p.endsWith(".rs")
	) {
		return {
			framework: "rust-web",
			entryPointMultiplier: 2.5,
			reason: "rust-handlers",
		};
	}

	// Rust main.rs (THE entry point)
	if (p.endsWith("/main.rs")) {
		return { framework: "rust", entryPointMultiplier: 3.0, reason: "rust-main" };
	}

	// Rust bin folder (executables)
	if (p.includes("/bin/") && p.endsWith(".rs")) {
		return { framework: "rust", entryPointMultiplier: 2.5, reason: "rust-bin" };
	}

	// ========== C / C++ ==========

	// C/C++ main files
	if (
		p.endsWith("/main.c") ||
		p.endsWith("/main.cpp") ||
		p.endsWith("/main.cc")
	) {
		return { framework: "c-cpp", entryPointMultiplier: 3.0, reason: "c-main" };
	}

	// C/C++ src folder entry points (if named specifically)
	if (p.includes("/src/") && (p.endsWith("/app.c") || p.endsWith("/app.cpp"))) {
		return { framework: "c-cpp", entryPointMultiplier: 2.5, reason: "c-app" };
	}

	// ========== PHP / LARAVEL FRAMEWORKS ==========

	// Laravel routes (highest - these ARE the entry point definitions)
	if (p.includes("/routes/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 3.0,
			reason: "laravel-routes",
		};
	}

	// Laravel controllers (very high - receive HTTP requests)
	if (
		(p.includes("/http/controllers/") || p.includes("/controllers/")) &&
		p.endsWith(".php")
	) {
		return {
			framework: "laravel",
			entryPointMultiplier: 3.0,
			reason: "laravel-controller",
		};
	}

	// Laravel controller by file name convention
	if (p.endsWith("controller.php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 3.0,
			reason: "laravel-controller-file",
		};
	}

	// Laravel console commands
	if (
		(p.includes("/console/commands/") || p.includes("/commands/")) &&
		p.endsWith(".php")
	) {
		return {
			framework: "laravel",
			entryPointMultiplier: 2.5,
			reason: "laravel-command",
		};
	}

	// Laravel jobs (queue entry points)
	if (p.includes("/jobs/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 2.5,
			reason: "laravel-job",
		};
	}

	// Laravel listeners (event-driven entry points)
	if (p.includes("/listeners/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 2.5,
			reason: "laravel-listener",
		};
	}

	// Laravel middleware
	if (p.includes("/http/middleware/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 2.5,
			reason: "laravel-middleware",
		};
	}

	// Laravel service providers
	if (p.includes("/providers/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 1.8,
			reason: "laravel-provider",
		};
	}

	// Laravel policies
	if (p.includes("/policies/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 2.0,
			reason: "laravel-policy",
		};
	}

	// Laravel models (important but not entry points per se)
	if (p.includes("/models/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 1.5,
			reason: "laravel-model",
		};
	}

	// Laravel services (Service Repository pattern)
	if (p.includes("/services/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 1.8,
			reason: "laravel-service",
		};
	}

	// Laravel repositories (Service Repository pattern)
	if (p.includes("/repositories/") && p.endsWith(".php")) {
		return {
			framework: "laravel",
			entryPointMultiplier: 1.5,
			reason: "laravel-repository",
		};
	}


	return null;
}

export function detectMobileFramework(
	context: PathFrameworkContext,
): FrameworkHint | null {
	const { p } = context;
	// ========== RUBY ==========

	// Ruby: bin/ or exe/ (CLI entry points)
	if ((p.includes("/bin/") || p.includes("/exe/")) && p.endsWith(".rb")) {
		return {
			framework: "ruby",
			entryPointMultiplier: 2.5,
			reason: "ruby-executable",
		};
	}

	// Ruby: Rakefile or *.rake (task definitions)
	if (p.endsWith("/rakefile") || p.endsWith(".rake")) {
		return { framework: "ruby", entryPointMultiplier: 1.5, reason: "ruby-rake" };
	}

	// ========== SWIFT / iOS ==========

	// iOS App entry points (highest priority)
	if (
		p.endsWith("/appdelegate.swift") ||
		p.endsWith("/scenedelegate.swift") ||
		p.endsWith("/app.swift")
	) {
		return {
			framework: "ios",
			entryPointMultiplier: 3.0,
			reason: "ios-app-entry",
		};
	}

	// SwiftUI App entry (@main)
	if (p.endsWith("app.swift") && p.includes("/sources/")) {
		return {
			framework: "swiftui",
			entryPointMultiplier: 3.0,
			reason: "swiftui-app",
		};
	}

	// UIKit ViewControllers (high priority - screen entry points)
	if (
		(p.includes("/viewcontrollers/") ||
			p.includes("/controllers/") ||
			p.includes("/screens/")) &&
		p.endsWith(".swift")
	) {
		return {
			framework: "uikit",
			entryPointMultiplier: 2.5,
			reason: "uikit-viewcontroller",
		};
	}

	// ViewController by filename convention
	if (p.endsWith("viewcontroller.swift") || p.endsWith("vc.swift")) {
		return {
			framework: "uikit",
			entryPointMultiplier: 2.5,
			reason: "uikit-viewcontroller-file",
		};
	}

	// Coordinator pattern (navigation entry points)
	if (p.includes("/coordinators/") && p.endsWith(".swift")) {
		return {
			framework: "ios-coordinator",
			entryPointMultiplier: 2.5,
			reason: "ios-coordinator",
		};
	}

	// Coordinator by filename
	if (p.endsWith("coordinator.swift")) {
		return {
			framework: "ios-coordinator",
			entryPointMultiplier: 2.5,
			reason: "ios-coordinator-file",
		};
	}

	// SwiftUI Views (moderate - reusable components)
	if (
		(p.includes("/views/") || p.includes("/scenes/")) &&
		p.endsWith(".swift")
	) {
		return {
			framework: "swiftui",
			entryPointMultiplier: 1.8,
			reason: "swiftui-view",
		};
	}

	// Service layer
	if (p.includes("/services/") && p.endsWith(".swift")) {
		return {
			framework: "ios-service",
			entryPointMultiplier: 1.8,
			reason: "ios-service",
		};
	}

	// Router / navigation
	if (p.includes("/router/") && p.endsWith(".swift")) {
		return {
			framework: "ios-router",
			entryPointMultiplier: 2.0,
			reason: "ios-router",
		};
	}

	// ========== DART / FLUTTER ==========

	// Flutter main/app entry points
	if (p.endsWith("/main.dart") || p.endsWith("/app.dart")) {
		return {
			framework: "flutter",
			entryPointMultiplier: 3.0,
			reason: "flutter-main",
		};
	}

	// Flutter screens/pages/views (high priority - route entry points)
	if (
		(p.includes("/screens/") || p.includes("/pages/") || p.includes("/views/")) &&
		p.endsWith(".dart")
	) {
		return {
			framework: "flutter",
			entryPointMultiplier: 2.5,
			reason: "flutter-screen",
		};
	}

	// Flutter routes
	if (p.includes("/routes/") && p.endsWith(".dart")) {
		return {
			framework: "flutter",
			entryPointMultiplier: 2.5,
			reason: "flutter-routes",
		};
	}

	// Flutter BLoC / controllers / presentation (state management entry points)
	if (
		(p.includes("/bloc/") ||
			p.includes("/controllers/") ||
			p.includes("/cubit/") ||
			p.includes("/presentation/")) &&
		p.endsWith(".dart")
	) {
		return {
			framework: "flutter",
			entryPointMultiplier: 2.0,
			reason: "flutter-state-management",
		};
	}

	// Flutter services / domain
	if (
		(p.includes("/services/") || p.includes("/domain/")) &&
		p.endsWith(".dart")
	) {
		return {
			framework: "flutter",
			entryPointMultiplier: 1.8,
			reason: "flutter-service",
		};
	}

	// Flutter widgets (reusable components)
	if (p.includes("/widgets/") && p.endsWith(".dart")) {
		return {
			framework: "flutter",
			entryPointMultiplier: 1.5,
			reason: "flutter-widget",
		};
	}


	return null;
}

