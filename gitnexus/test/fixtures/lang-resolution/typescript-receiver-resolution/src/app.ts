import { Repo } from "./repo";
import { User } from "./user";

export function processEntities(): void {
	const user: User = new User();
	const repo: Repo = new Repo();
	user.save();
	repo.save();
}
