import { Address, City, User } from "./models";

export function getUser(): User {
	return new User(new Address(new City("NYC")));
}
