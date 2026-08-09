/**
 * Local Backend (Multi-Repo)
 *
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

export { isWriteQuery } from "../../core/lbug/pool-adapter.js";
export {
	IMPACT_RELATION_CONFIDENCE,
	VALID_NODE_LABELS,
	VALID_RELATION_TYPES,
	isTestFilePath,
} from "./local-backend/formatting-errors.js";
export type { CodebaseContext } from "./local-backend/formatting-errors.js";

import { DispatchBackend } from "./local-backend/dispatch.js";

export class LocalBackend extends DispatchBackend {}
