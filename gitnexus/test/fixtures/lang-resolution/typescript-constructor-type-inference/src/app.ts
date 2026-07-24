import { Repo } from "./repo";
import { User } from "./user";

export function processEntities(): void {
	const user = new User("alice");
	const repo = new Repo("/tmp/repo");
	user.save();
	repo.save();
}
