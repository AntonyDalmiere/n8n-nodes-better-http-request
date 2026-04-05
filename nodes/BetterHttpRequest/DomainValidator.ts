import { NodeOperationError } from 'n8n-workflow';
import type { INode, IDataObject } from 'n8n-workflow';

/**
 * Validates whether a URL's hostname is in the allowed domains list.
 * Supports exact matches and subdomains (e.g., 'example.com' allows 'sub.example.com')
 */
export function isDomainAllowed(url: string, opts: { allowedDomains: string }): boolean {
	try {
		const parsedUrl = new URL(url);
		const hostname = parsedUrl.hostname.toLowerCase();
		const allowedDomains = opts.allowedDomains
			.split(',')
			.map((d: string) => d.trim().toLowerCase())
			.filter((d: string) => d.length > 0);
		return allowedDomains.some(
			(domain: string) => hostname === domain || hostname.endsWith('.' + domain),
		);
	} catch {
		return false;
	}
}

/**
 * Checks if a credential's domain restrictions allow access to the requested URL.
 * Throws an error if the URL is not allowed or no domains are specified.
 */
export async function checkDomainRestrictions(
	node: INode,
	credentialData: IDataObject,
	requestUrl: string,
	credentialType?: string,
): Promise<void> {
	if (credentialData.allowedHttpRequestDomains === 'domains') {
		const allowedDomains = credentialData.allowedDomains as string;
		if (!allowedDomains || allowedDomains.trim() === '') {
			throw new NodeOperationError(
				node,
				'No allowed domains specified. Configure allowed domains or change restriction setting.',
			);
		}

		if (!isDomainAllowed(requestUrl, { allowedDomains })) {
			const credentialInfo = credentialType ? ` (${credentialType})` : '';
			throw new NodeOperationError(
				node,
				`Domain not allowed: This credential${credentialInfo} is restricted from accessing ${requestUrl}. ` +
					`Only the following domains are allowed: ${allowedDomains}`,
			);
		}
	} else if (credentialData.allowedHttpRequestDomains === 'none') {
		throw new NodeOperationError(
			node,
			'This credential is configured to prevent use within an HTTP Request node',
		);
	}
}

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
