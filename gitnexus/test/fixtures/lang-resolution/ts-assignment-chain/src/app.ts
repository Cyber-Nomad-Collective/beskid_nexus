import { Repo } from "./repo";
import { User } from "./user";

function getUser(): User {
	return new User();
}
function getRepo(): Repo {
	return new Repo();
}

export function processEntities(): void {
	const u: User = getUser();
	const alias = u;
	alias.save();

	const r: Repo = getRepo();
	const rAlias = r;
	rAlias.save();
}
