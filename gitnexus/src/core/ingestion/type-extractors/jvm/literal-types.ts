import type { LiteralTypeInferrer } from "../types.js";

export const inferJvmLiteralType: LiteralTypeInferrer = (node) => {
	switch (node.type) {
		case "decimal_integer_literal":
		case "integer_literal":
		case "hex_integer_literal":
		case "octal_integer_literal":
		case "binary_integer_literal":
			// Check for long suffix
			if (node.text.endsWith("L") || node.text.endsWith("l")) return "long";
			return "int";
		case "decimal_floating_point_literal":
		case "real_literal":
			if (node.text.endsWith("f") || node.text.endsWith("F")) return "float";
			return "double";
		case "string_literal":
		case "line_string_literal":
		case "multi_line_string_literal":
			return "String";
		case "character_literal":
			return "char";
		case "true":
		case "false":
		case "boolean_literal":
			return "boolean";
		case "null_literal":
			return "null";
		default:
			return undefined;
	}
};
