import { NodeOperationError } from 'n8n-workflow';
import type { INode } from 'n8n-workflow';

/**
 * Validates URL protocol (http:// or https://).
 * Throws an error if protocol is invalid.
 */
export function validateUrlProtocol(node: INode, url: string, itemIndex: number): void {
	if (!url.startsWith('http://') && !url.startsWith('https://')) {
		throw new NodeOperationError(
			node,
			`Invalid URL: ${url}. URL must start with "http" or "https".`,
			{ itemIndex },
		);
	}
}

/**
 * Validates URL is a string type.
 * Throws an error if URL is not a string.
 */
export function validateUrlType(node: INode, url: any, itemIndex: number): asserts url is string {
	if (typeof url !== 'string') {
		const actualType = url === null ? 'null' : typeof url;
		throw new NodeOperationError(
			node,
			`URL parameter must be a string, got ${actualType}`,
			{ itemIndex },
		);
	}
}

/**
 * Performs complete URL validation (type and protocol).
 */
export function validateUrl(node: INode, url: any, itemIndex: number): asserts url is string {
	validateUrlType(node, url, itemIndex);
	validateUrlProtocol(node, url, itemIndex);
}
