import type { ProgressCallback } from "./contracts.js";

export async function runParallel<T>(
	items: T[],
	fn: (item: T) => Promise<number>,
	concurrency: number,
	onProgress: ProgressCallback,
	getLastPercent: () => number,
): Promise<number> {
	let total = 0;
	let activeConcurrency = concurrency;
	let running = 0;
	let idx = 0;

	return new Promise((resolve, _reject) => {
		const next = () => {
			while (running < activeConcurrency && idx < items.length) {
				const item = items[idx++];
				running++;

				fn(item)
					.then((count) => {
						total += count;
						running--;
						if (idx >= items.length && running === 0) {
							resolve(total);
						} else {
							next();
						}
					})
					.catch((err) => {
						running--;
						// On rate limit, reduce concurrency temporarily
						if (err.message?.includes("429")) {
							activeConcurrency = Math.max(1, activeConcurrency - 1);
							onProgress(
								"modules",
								getLastPercent(),
								`Rate limited — concurrency → ${activeConcurrency}`,
							);
							// Re-queue the item
							idx--;
							setTimeout(next, 5000);
						} else if (idx >= items.length && running === 0) {
							resolve(total);
						} else {
							next();
						}
					});
			}
		};

		if (items.length === 0) {
			resolve(0);
		} else {
			next();
		}
	});
}
