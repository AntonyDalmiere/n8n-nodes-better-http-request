import { jsonParse } from 'n8n-workflow';
import type { IDataObject, IRequestOptions } from 'n8n-workflow';
import type { IAuthDataSanitizeKeys } from './helpers';

interface CredentialsMap {
	httpBasicAuth?: IDataObject;
	httpBearerAuth?: IDataObject;
	httpDigestAuth?: IDataObject;
	httpHeaderAuth?: IDataObject;
	httpQueryAuth?: IDataObject;
	httpCustomAuth?: IDataObject;
}

/**
 * Applies HTTP Basic Authentication to request options
 */
export function applyBasicAuth(
	options: IRequestOptions,
	credentials: IDataObject,
	authKeys: IAuthDataSanitizeKeys,
): void {
	options.auth = {
		user: credentials.user as string,
		pass: credentials.password as string,
	};
	authKeys.auth = ['pass'];
}

/**
 * Applies HTTP Bearer Token Authentication to request options
 */
export function applyBearerAuth(
	options: IRequestOptions,
	credentials: IDataObject,
	authKeys: IAuthDataSanitizeKeys,
): void {
	options.headers = options.headers ?? {};
	options.headers.Authorization = `Bearer ${String(credentials.token)}`;
	authKeys.headers = ['Authorization'];
}

/**
 * Applies HTTP Digest Authentication to request options
 */
export function applyDigestAuth(
	options: IRequestOptions,
	credentials: IDataObject,
	authKeys: IAuthDataSanitizeKeys,
): void {
	options.auth = {
		user: credentials.user as string,
		pass: credentials.password as string,
		sendImmediately: false,
	};
	authKeys.auth = ['pass'];
}

/**
 * Applies HTTP Header Authentication to request options
 */
export function applyHeaderAuth(
	options: IRequestOptions,
	credentials: IDataObject,
	authKeys: IAuthDataSanitizeKeys,
): void {
	options.headers = options.headers ?? {};
	options.headers[credentials.name as string] = credentials.value;
	authKeys.headers = [credentials.name as string];
}

/**
 * Applies HTTP Query Parameter Authentication to request options
 */
export function applyQueryAuth(
	options: IRequestOptions,
	credentials: IDataObject,
	authKeys: IAuthDataSanitizeKeys,
): void {
	if (!options.qs) {
		options.qs = {};
	}
	options.qs[credentials.name as string] = credentials.value;
	authKeys.qs = [credentials.name as string];
}

/**
 * Applies Custom JSON Authentication to request options
 */
export function applyCustomAuth(
	options: IRequestOptions,
	credentials: IDataObject,
	authKeys: IAuthDataSanitizeKeys,
): void {
	const customAuth = jsonParse<{ headers?: IDataObject; body?: IDataObject; qs?: IDataObject }>(
		(credentials.json as string) || '{}',
		{ errorMessage: 'Invalid Custom Auth JSON' },
	);

	if (customAuth.headers) {
		options.headers = {
			...options.headers,
			...customAuth.headers,
		};
		authKeys.headers = Object.keys(customAuth.headers);
	}
	if (customAuth.body) {
		options.body = {
			...(options.body as IDataObject),
			...customAuth.body,
		};
		authKeys.body = Object.keys(customAuth.body);
	}
	if (customAuth.qs) {
		options.qs = { ...options.qs, ...customAuth.qs };
		authKeys.qs = Object.keys(customAuth.qs);
	}
}
/**
 * Applies all loaded credentials to the request options
 */
export function applyAllCredentials(
	options: IRequestOptions,
	credentials: CredentialsMap,
	authKeys: IAuthDataSanitizeKeys,
): void {
	if (credentials.httpBasicAuth) {
		applyBasicAuth(options, credentials.httpBasicAuth, authKeys);
	}
	if (credentials.httpBearerAuth) {
		applyBearerAuth(options, credentials.httpBearerAuth, authKeys);
	}
	if (credentials.httpHeaderAuth) {
		applyHeaderAuth(options, credentials.httpHeaderAuth, authKeys);
	}
	if (credentials.httpQueryAuth) {
		applyQueryAuth(options, credentials.httpQueryAuth, authKeys);
	}
	if (credentials.httpDigestAuth) {
		applyDigestAuth(options, credentials.httpDigestAuth, authKeys);
	}
	if (credentials.httpCustomAuth) {
		applyCustomAuth(options, credentials.httpCustomAuth, authKeys);
	}
}
