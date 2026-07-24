import { BaseModel, type Serializable } from "./Base";

export class User extends BaseModel implements Serializable {
	serialize(): string {
		return "";
	}
}
