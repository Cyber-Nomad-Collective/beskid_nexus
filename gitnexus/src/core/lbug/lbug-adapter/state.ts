import lbug from "@ladybugdb/core";

interface AdapterState {
	db: lbug.Database | null;
	conn: lbug.Connection | null;
	currentDbPath: string | null;
	ftsLoaded: boolean;
	vectorExtensionLoaded: boolean;
	ensuredFTSIndexes: Set<string>;
	sessionLock: Promise<void>;
}

export const adapterState: AdapterState = {
	db: null,
	conn: null,
	currentDbPath: null,
	ftsLoaded: false,
	vectorExtensionLoaded: false,
	ensuredFTSIndexes: new Set<string>(),
	sessionLock: Promise.resolve(),
};

