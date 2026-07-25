import type { IRepository } from "./repository";

export class SqlRepository implements IRepository {
	find(_id: number): string {
		return "found";
	}

	save(_entity: string): boolean {
		return true;
	}
}
