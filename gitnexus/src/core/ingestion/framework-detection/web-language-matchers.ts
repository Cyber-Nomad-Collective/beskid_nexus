import type {
	FrameworkHint,
	PathFrameworkContext,
} from "./contracts.js";

export function detectWebLanguageFramework(
	context: PathFrameworkContext,
): FrameworkHint | null {
	const { p, originalPathWithLeadingSlash } = context;
	// ========== JAVASCRIPT / TYPESCRIPT FRAMEWORKS ==========

	// Next.js - Pages Router (high confidence)
	if (p.includes("/pages/") && !p.includes("/_") && !p.includes("/api/")) {
		if (
			p.endsWith(".tsx") ||
			p.endsWith(".ts") ||
			p.endsWith(".jsx") ||
			p.endsWith(".js")
		) {
			return {
				framework: "nextjs-pages",
				entryPointMultiplier: 3.0,
				reason: "nextjs-page",
			};
		}
	}

	// Next.js - App Router (page.tsx files)
	if (
		p.includes("/app/") &&
		(p.endsWith("page.tsx") ||
			p.endsWith("page.ts") ||
			p.endsWith("page.jsx") ||
			p.endsWith("page.js"))
	) {
		return {
			framework: "nextjs-app",
			entryPointMultiplier: 3.0,
			reason: "nextjs-app-page",
		};
	}

	// Next.js - API Routes
	if (
		p.includes("/pages/api/") ||
		(p.includes("/app/") && p.includes("/api/") && p.endsWith("route.ts"))
	) {
		return {
			framework: "nextjs-api",
			entryPointMultiplier: 3.0,
			reason: "nextjs-api-route",
		};
	}

	// Next.js - Layout files (moderate - they're entry-ish but not the main entry)
	if (
		p.includes("/app/") &&
		!p.includes("_layout") &&
		(p.endsWith("layout.tsx") || p.endsWith("layout.ts"))
	) {
		return {
			framework: "nextjs-app",
			entryPointMultiplier: 2.0,
			reason: "nextjs-layout",
		};
	}

	// Expo Router - screen/layout/api files in app/ directory
	if (
		p.includes("/app/") &&
		(p.endsWith(".tsx") ||
			p.endsWith(".ts") ||
			p.endsWith(".jsx") ||
			p.endsWith(".js"))
	) {
		const fn = p.split("/").pop() || "";
		if (fn.startsWith("_layout")) {
			return {
				framework: "expo-router",
				entryPointMultiplier: 2.0,
				reason: "expo-layout",
			};
		}
		if (fn.startsWith("+") && !fn.startsWith("+api")) {
			return {
				framework: "expo-router",
				entryPointMultiplier: 1.5,
				reason: "expo-special-route",
			};
		}
		if (fn.endsWith("+api.ts") || fn.endsWith("+api.tsx")) {
			return {
				framework: "expo-router",
				entryPointMultiplier: 3.0,
				reason: "expo-api-route",
			};
		}
		return {
			framework: "expo-router",
			entryPointMultiplier: 2.5,
			reason: "expo-screen",
		};
	}

	// Prisma schema (ORM data model definition)
	if (p.includes("/prisma/") && p.endsWith("schema.prisma")) {
		return {
			framework: "prisma",
			entryPointMultiplier: 1.5,
			reason: "prisma-schema",
		};
	}

	// Supabase client files
	if (
		(p.includes("/lib/supabase") ||
			p.includes("/utils/supabase") ||
			p.includes("/supabase/")) &&
		(p.endsWith(".ts") || p.endsWith(".js"))
	) {
		return {
			framework: "supabase",
			entryPointMultiplier: 1.5,
			reason: "supabase-client",
		};
	}

	// Express / Node.js routes
	if (p.includes("/routes/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
		return {
			framework: "express",
			entryPointMultiplier: 2.5,
			reason: "routes-folder",
		};
	}

	// Generic controllers (MVC pattern)
	if (p.includes("/controllers/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
		return {
			framework: "mvc",
			entryPointMultiplier: 2.5,
			reason: "controllers-folder",
		};
	}

	// Generic handlers
	if (p.includes("/handlers/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
		return {
			framework: "handlers",
			entryPointMultiplier: 2.5,
			reason: "handlers-folder",
		};
	}

	// React components (lower priority - not all are entry points)
	if (
		(p.includes("/components/") || p.includes("/views/")) &&
		(p.endsWith(".tsx") || p.endsWith(".jsx"))
	) {
		// Only boost if PascalCase filename (likely a component, not util)
		const fileName = originalPathWithLeadingSlash.split("/").pop() || "";
		if (/^[A-Z]/.test(fileName)) {
			return {
				framework: "react",
				entryPointMultiplier: 1.5,
				reason: "react-component",
			};
		}
	}

	// ========== PYTHON FRAMEWORKS ==========

	// Django views (high confidence)
	if (p.endsWith("views.py")) {
		return {
			framework: "django",
			entryPointMultiplier: 3.0,
			reason: "django-views",
		};
	}

	// Django URL configs
	if (p.endsWith("urls.py")) {
		return {
			framework: "django",
			entryPointMultiplier: 2.0,
			reason: "django-urls",
		};
	}

	// FastAPI / Flask routers
	if (
		(p.includes("/routers/") ||
			p.includes("/endpoints/") ||
			p.includes("/routes/")) &&
		p.endsWith(".py")
	) {
		return {
			framework: "fastapi",
			entryPointMultiplier: 2.5,
			reason: "api-routers",
		};
	}

	// Python API folder
	if (p.includes("/api/") && p.endsWith(".py") && !p.endsWith("__init__.py")) {
		return {
			framework: "python-api",
			entryPointMultiplier: 2.0,
			reason: "api-folder",
		};
	}

	// ========== JAVA FRAMEWORKS ==========

	// Spring Boot controllers
	if (
		(p.includes("/controller/") || p.includes("/controllers/")) &&
		p.endsWith(".java")
	) {
		return {
			framework: "spring",
			entryPointMultiplier: 3.0,
			reason: "spring-controller",
		};
	}

	// Spring Boot - files ending in Controller.java
	if (p.endsWith("controller.java")) {
		return {
			framework: "spring",
			entryPointMultiplier: 3.0,
			reason: "spring-controller-file",
		};
	}

	// Java service layer (often entry points for business logic)
	if (
		(p.includes("/service/") || p.includes("/services/")) &&
		p.endsWith(".java")
	) {
		return {
			framework: "java-service",
			entryPointMultiplier: 1.8,
			reason: "java-service",
		};
	}

	// ========== KOTLIN FRAMEWORKS ==========

	// Spring Boot Kotlin controllers
	if (
		(p.includes("/controller/") || p.includes("/controllers/")) &&
		p.endsWith(".kt")
	) {
		return {
			framework: "spring-kotlin",
			entryPointMultiplier: 3.0,
			reason: "spring-kotlin-controller",
		};
	}

	// Spring Boot - files ending in Controller.kt
	if (p.endsWith("controller.kt")) {
		return {
			framework: "spring-kotlin",
			entryPointMultiplier: 3.0,
			reason: "spring-kotlin-controller-file",
		};
	}

	// Ktor routes
	if (p.includes("/routes/") && p.endsWith(".kt")) {
		return {
			framework: "ktor",
			entryPointMultiplier: 2.5,
			reason: "ktor-routes",
		};
	}

	// Ktor plugins folder or Routing.kt files
	if (p.includes("/plugins/") && p.endsWith(".kt")) {
		return {
			framework: "ktor",
			entryPointMultiplier: 2.0,
			reason: "ktor-plugin",
		};
	}
	if (p.endsWith("routing.kt") || p.endsWith("routes.kt")) {
		return {
			framework: "ktor",
			entryPointMultiplier: 2.5,
			reason: "ktor-routing-file",
		};
	}

	// Android Activities, Fragments
	if ((p.includes("/activity/") || p.includes("/ui/")) && p.endsWith(".kt")) {
		return {
			framework: "android-kotlin",
			entryPointMultiplier: 2.5,
			reason: "android-ui",
		};
	}
	if (p.endsWith("activity.kt") || p.endsWith("fragment.kt")) {
		return {
			framework: "android-kotlin",
			entryPointMultiplier: 2.5,
			reason: "android-component",
		};
	}

	// Kotlin main entry point
	if (p.endsWith("/main.kt")) {
		return {
			framework: "kotlin",
			entryPointMultiplier: 3.0,
			reason: "kotlin-main",
		};
	}

	// Kotlin Application entry point (common naming)
	if (p.endsWith("/application.kt")) {
		return {
			framework: "kotlin",
			entryPointMultiplier: 2.5,
			reason: "kotlin-application",
		};
	}

	// ========== C# / .NET FRAMEWORKS ==========

	// ASP.NET Controllers
	if (p.includes("/controllers/") && p.endsWith(".cs")) {
		return {
			framework: "aspnet",
			entryPointMultiplier: 3.0,
			reason: "aspnet-controller",
		};
	}

	// ASP.NET - files ending in Controller.cs
	if (p.endsWith("controller.cs")) {
		return {
			framework: "aspnet",
			entryPointMultiplier: 3.0,
			reason: "aspnet-controller-file",
		};
	}

	// ASP.NET Services
	if (
		(p.includes("/services/") || p.includes("/service/")) &&
		p.endsWith(".cs")
	) {
		return {
			framework: "aspnet",
			entryPointMultiplier: 1.8,
			reason: "aspnet-service",
		};
	}

	// ASP.NET Middleware
	if (p.includes("/middleware/") && p.endsWith(".cs")) {
		return {
			framework: "aspnet",
			entryPointMultiplier: 2.5,
			reason: "aspnet-middleware",
		};
	}

	// SignalR Hubs
	if (p.includes("/hubs/") && p.endsWith(".cs")) {
		return {
			framework: "signalr",
			entryPointMultiplier: 2.5,
			reason: "signalr-hub",
		};
	}
	if (p.endsWith("hub.cs")) {
		return {
			framework: "signalr",
			entryPointMultiplier: 2.5,
			reason: "signalr-hub-file",
		};
	}

	// Minimal API / Program.cs / Startup.cs
	if (p.endsWith("/program.cs") || p.endsWith("/startup.cs")) {
		return {
			framework: "aspnet",
			entryPointMultiplier: 3.0,
			reason: "aspnet-entry",
		};
	}

	// Background services / Hosted services
	if (
		(p.includes("/backgroundservices/") || p.includes("/hostedservices/")) &&
		p.endsWith(".cs")
	) {
		return {
			framework: "aspnet",
			entryPointMultiplier: 2.0,
			reason: "aspnet-background-service",
		};
	}

	// Blazor pages
	if (p.includes("/pages/") && p.endsWith(".razor")) {
		return {
			framework: "blazor",
			entryPointMultiplier: 2.5,
			reason: "blazor-page",
		};
	}


	return null;
}

