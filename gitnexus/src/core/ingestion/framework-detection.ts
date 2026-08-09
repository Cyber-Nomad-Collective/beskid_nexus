/**
 * Framework Detection
 *
 * Detects framework entry points from file conventions and AST definition text.
 */
export {
	detectFrameworkFromAST,
} from "./framework-detection/ast-rules.js";
export type {
	FrameworkHint,
} from "./framework-detection/contracts.js";
export {
	detectFrameworkFromPath,
} from "./framework-detection/path-rules.js";
