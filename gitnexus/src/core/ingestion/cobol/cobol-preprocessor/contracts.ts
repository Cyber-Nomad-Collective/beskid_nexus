export interface CobolRegexResults {
	programName: string | null;
	/** All programs in this file with line-range boundaries for per-program scoping. */
	programs: Array<{
		name: string;
		startLine: number;
		endLine: number;
		nestingDepth: number;
		procedureUsing?: string[];
		isCommon?: boolean;
	}>;
	paragraphs: Array<{ name: string; line: number }>;
	sections: Array<{ name: string; line: number }>;
	performs: Array<{
		caller: string | null;
		target: string;
		thruTarget?: string;
		line: number;
	}>;
	calls: Array<{
		target: string;
		line: number;
		isQuoted: boolean;
		parameters?: string[];
		returning?: string;
	}>;
	copies: Array<{ target: string; line: number }>;
	dataItems: Array<{
		name: string;
		level: number;
		line: number;
		pic?: string;
		usage?: string;
		occurs?: number;
		dependingOn?: string;
		redefines?: string;
		values?: string[];
		isExternal?: boolean;
		isGlobal?: boolean;
		section:
			| "working-storage"
			| "linkage"
			| "file"
			| "local-storage"
			| "screen"
			| "unknown";
	}>;
	fileDeclarations: Array<{
		selectName: string;
		assignTo: string;
		organization?: string;
		access?: string;
		recordKey?: string;
		alternateKeys?: string[];
		fileStatus?: string;
		isOptional?: boolean;
		line: number;
	}>;
	fdEntries: Array<{
		fdName: string;
		recordName?: string;
		line: number;
	}>;
	programMetadata: {
		author?: string;
		dateWritten?: string;
		dateCompiled?: string;
		installation?: string;
	};

	// Phase 2: EXEC blocks
	execSqlBlocks: Array<{
		line: number;
		tables: string[];
		cursors: string[];
		hostVariables: string[];
		operation:
			| "SELECT"
			| "INSERT"
			| "UPDATE"
			| "DELETE"
			| "DECLARE"
			| "OPEN"
			| "CLOSE"
			| "FETCH"
			| "OTHER";
		includeMember?: string;
	}>;
	execCicsBlocks: Array<{
		line: number;
		command: string;
		mapName?: string;
		programName?: string;
		programIsLiteral?: boolean;
		transId?: string;
		fileName?: string;
		fileIsLiteral?: boolean;
		queueName?: string;
		labelName?: string;
		intoField?: string;
		fromField?: string;
	}>;

	// Phase 3: Linkage + Data Flow
	procedureUsing: string[];
	entryPoints: Array<{
		name: string;
		parameters: string[];
		line: number;
	}>;
	moves: Array<{
		from: string;
		targets: string[];
		line: number;
		caller: string | null;
		corresponding: boolean;
	}>;

	// Phase 4: Additional structural features
	gotos: Array<{ caller: string | null; target: string; line: number }>;
	sorts: Array<{
		sortFile: string;
		usingFiles: string[];
		givingFiles: string[];
		line: number;
	}>;
	searches: Array<{ target: string; line: number }>;
	cancels: Array<{ target: string; line: number; isQuoted: boolean }>;

	// Phase 2.1: EXEC DLI (IMS/DB)
	execDliBlocks: Array<{
		line: number;
		verb: string;
		pcbNumber?: number;
		segmentName?: string;
		intoField?: string;
		fromField?: string;
		psbName?: string;
	}>;

	// Phase 2.2: DECLARATIVES
	declaratives: Array<{
		sectionName: string;
		target: string; // file-name or INPUT/OUTPUT/I-O/EXTEND
		line: number;
	}>;

	// Phase 2.3: SET statement
	sets: Array<{
		targets: string[];
		form: "to-true" | "to-value" | "up-by" | "down-by";
		value?: string;
		line: number;
		caller: string | null;
	}>;

	// Phase 2.4: INSPECT
	inspects: Array<{
		inspectedField: string;
		counters: string[];
		form: "tallying" | "replacing" | "converting" | "tallying-replacing";
		line: number;
		caller: string | null;
	}>;

	// Phase 4.1: INITIALIZE
	initializes: Array<{ target: string; line: number; caller: string | null }>;
}
