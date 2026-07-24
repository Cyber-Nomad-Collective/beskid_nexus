import type { Repo } from "./repo";
import type { User } from "./user";

export function handleUser(entity: User): void {
	entity.save();
}

export function handleRepo(entity: Repo): void {
	entity.save();
}
