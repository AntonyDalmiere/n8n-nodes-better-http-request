import type { IDataObject, INode } from 'n8n-workflow';
import { NodeOperationError, ensureError } from 'n8n-workflow';

/**
 * Converts any data type to text representation.
 * Stringifies objects/arrays and returns primitives as-is.
 */
export function toText<T>(data: T): T | string {
	if (typeof data === 'object' && data !== null) {
		return JSON.stringify(data);
	}

	return data;
}

/**
 * Parses JSON string and throws descriptive error if invalid.
 */
export function parseJsonParameter(
	node: INode,
	jsonString: string,
	fieldName: string,
	itemIndex: number,
): IDataObject {
	try {
		return JSON.parse(jsonString) as IDataObject;
	} catch (e) {
		const error = ensureError(e);
		throw new NodeOperationError(
			node,
			`The value in the "${fieldName}" field is not valid JSON`,
			{
				itemIndex,
				description: error.message,
			},
		);
	}
}