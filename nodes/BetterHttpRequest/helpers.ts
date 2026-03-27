import set from 'lodash/set';
import isPlainObject from 'lodash/isPlainObject';
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	INodeExecutionData,
	INodeProperties,
	IOAuth2Options,
	IRequestOptions,
	IBinaryData,
} from 'n8n-workflow';
import { deepCopy } from 'n8n-workflow';

// ─── Types ──────────────────────────────────────────────────────────────────

export type BodyParameter = {
	name: string;
	value: string;
	parameterType?: 'formBinaryData' | 'formData';
};

export type IAuthDataSanitizeKeys = {
	[key: string]: string[];
};

export type HttpSslAuthCredentials = {
	ca?: string;
	cert?: string;
	key?: string;
	passphrase?: string;
};

export type BodyParametersReducer = (
	acc: IDataObject,
	cur: { name: string; value: string },
) => Promise<IDataObject>;

// ─── Inlined utilities ──────────────────────────────────────────────────────

export function keysToLowercase<T>(headers: T): T {
	if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
		return headers;
	}
	return Object.entries(headers).reduce((acc, [key, value]) => {
		(acc as Record<string, unknown>)[key.toLowerCase()] = value;
		return acc;
	}, {} as Record<string, unknown>) as T;
}

export function formatPrivateKey(privateKey: string): string {
	if (!privateKey || typeof privateKey !== 'string') return privateKey;
	// Replace literal \n with real newlines
	let key = privateKey.replace(/\\n/g, '\n');
	// Ensure there's a newline after the BEGIN line and before the END line
	key = key.replace(/(-----BEGIN [A-Z ]+-----)\s*/, '$1\n');
	key = key.replace(/\s*(-----END [A-Z ]+-----)/, '\n$1');
	return key;
}

// ─── replaceNullValues ──────────────────────────────────────────────────────

export const replaceNullValues = (item: INodeExecutionData): INodeExecutionData => {
	if (item.json === null) {
		item.json = {};
	}
	return item;
};

// ─── sanitizeUiMessage / redact ─────────────────────────────────────────────

export const REDACTED = '**hidden**';

function isObject(obj: unknown): obj is IDataObject {
	return isPlainObject(obj);
}

function redact<T = unknown>(obj: T, secrets: string[]): T {
	if (typeof obj === 'string') {
		return secrets.reduce((safe, secret) => safe.replace(secret, REDACTED), obj) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => redact(item, secrets)) as T;
	} else if (isObject(obj)) {
		for (const [key, value] of Object.entries(obj)) {
			(obj as Record<string, unknown>)[key] = redact(value, secrets);
		}
	}
	return obj;
}

export function sanitizeUiMessage(
	request: IRequestOptions,
	authDataKeys: IAuthDataSanitizeKeys,
	secrets?: string[],
): IDataObject {
	const { body, ...rest } = request as IDataObject;
	let sendRequest: IDataObject = { body };
	for (const [key, value] of Object.entries(rest)) {
		sendRequest[key] = deepCopy(value);
	}

	if (Buffer.isBuffer(sendRequest.body) && (sendRequest.body as Buffer).length > 250000) {
		sendRequest = {
			...request,
			body: `Binary data got replaced with this text. Original was a Buffer with a size of ${
				(request.body as string).length
			} bytes.`,
		} as unknown as IDataObject;
	}

	for (const requestProperty of Object.keys(authDataKeys)) {
		sendRequest = {
			...sendRequest,
			[requestProperty]: Object.keys(sendRequest[requestProperty] as object).reduce(
				(acc: IDataObject, curr) => {
					acc[curr] = authDataKeys[requestProperty].includes(curr)
						? REDACTED
						: (sendRequest[requestProperty] as IDataObject)[curr];
					return acc;
				},
				{},
			),
		};
	}

	const HEADER_BLOCKLIST = new Set([
		'authorization',
		'x-api-key',
		'x-auth-token',
		'cookie',
		'proxy-authorization',
		'sslclientcert',
	]);
	const headers = sendRequest.headers as IDataObject;
	if (headers) {
		for (const headerName of Object.keys(headers)) {
			if (HEADER_BLOCKLIST.has(headerName.toLowerCase())) {
				headers[headerName] = REDACTED;
			}
		}
	}
	if (secrets && secrets.length > 0) {
		return redact(sendRequest, secrets) as IDataObject;
	}
	return sendRequest;
}

// ─── getSecrets ─────────────────────────────────────────────────────────────

export function getSecrets(
	properties: INodeProperties[],
	credentials: ICredentialDataDecryptedObject,
): string[] {
	const sensitivePropNames = new Set(
		properties.filter((prop) => prop.typeOptions?.password).map((prop) => prop.name),
	);
	const secrets = Object.entries(credentials)
		.filter(([propName]) => sensitivePropNames.has(propName))
		.map(([, value]) => value)
		.filter((value): value is string => typeof value === 'string');

	const oauthAccessToken =
		credentials.oauthTokenData &&
		typeof credentials.oauthTokenData === 'object' &&
		(credentials.oauthTokenData as IDataObject).access_token;
	if (typeof oauthAccessToken === 'string') {
		secrets.push(oauthAccessToken);
	}
	return secrets;
}

// ─── getOAuth2AdditionalParameters ──────────────────────────────────────────

export const getOAuth2AdditionalParameters = (
	nodeCredentialType: string,
): IOAuth2Options | undefined => {
	const oAuth2Options: { [credentialType: string]: IOAuth2Options } = {
		bitlyOAuth2Api: { tokenType: 'Bearer' },
		boxOAuth2Api: { includeCredentialsOnRefreshOnBody: true },
		ciscoWebexOAuth2Api: { tokenType: 'Bearer' },
		clickUpOAuth2Api: { keepBearer: false, tokenType: 'Bearer' },
		goToWebinarOAuth2Api: { tokenExpiredStatusCode: 403 },
		hubspotDeveloperApi: { tokenType: 'Bearer', includeCredentialsOnRefreshOnBody: true },
		hubspotOAuth2Api: { tokenType: 'Bearer', includeCredentialsOnRefreshOnBody: true },
		lineNotifyOAuth2Api: { tokenType: 'Bearer' },
		linkedInOAuth2Api: { tokenType: 'Bearer' },
		mailchimpOAuth2Api: { tokenType: 'Bearer' },
		mauticOAuth2Api: { includeCredentialsOnRefreshOnBody: true },
		microsoftAzureMonitorOAuth2Api: { tokenExpiredStatusCode: 403 },
		microsoftDynamicsOAuth2Api: { property: 'id_token' },
		philipsHueOAuth2Api: { tokenType: 'Bearer' },
		raindropOAuth2Api: { includeCredentialsOnRefreshOnBody: true },
		shopifyOAuth2Api: {
			tokenType: 'Bearer',
			keyToIncludeInAccessTokenHeader: 'X-Shopify-Access-Token',
		},
		slackOAuth2Api: { tokenType: 'Bearer', property: 'authed_user.access_token' },
		stravaOAuth2Api: { includeCredentialsOnRefreshOnBody: true },
	};
	return oAuth2Options[nodeCredentialType];
};

// ─── binaryContentTypes ─────────────────────────────────────────────────────

export const binaryContentTypes = [
	'image/',
	'audio/',
	'video/',
	'application/octet-stream',
	'application/gzip',
	'application/zip',
	'application/vnd.rar',
	'application/epub+zip',
	'application/x-bzip',
	'application/x-bzip2',
	'application/x-cdf',
	'application/vnd.amazon.ebook',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-fontobject',
	'application/vnd.oasis.opendocument.presentation',
	'application/pdf',
	'application/x-tar',
	'application/vnd.visio',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/x-7z-compressed',
];

// ─── reduceAsync ────────────────────────────────────────────────────────────

export async function reduceAsync<T, R>(
	arr: T[],
	reducer: (acc: Awaited<Promise<R>>, cur: T) => Promise<R>,
	init: Promise<R> = Promise.resolve({} as R),
): Promise<R> {
	return await arr.reduce(async (promiseAcc, item) => {
		return await reducer(await promiseAcc, item);
	}, init);
}

// ─── prepareRequestBody ─────────────────────────────────────────────────────

export const prepareRequestBody = async (
	parameters: BodyParameter[],
	bodyType: string,
	version: number,
	defaultReducer: BodyParametersReducer,
): Promise<IDataObject> => {
	if (bodyType === 'json' && version >= 4) {
		return await parameters.reduce(async (acc, entry) => {
			const result = await acc;
			set(result, entry.name, entry.value);
			return result;
		}, Promise.resolve({} as IDataObject));
	}
	return (await reduceAsync(parameters, defaultReducer)) as IDataObject;
};

// ─── setAgentOptions ────────────────────────────────────────────────────────

export const setAgentOptions = (
	requestOptions: IRequestOptions,
	sslCertificates: HttpSslAuthCredentials | undefined,
): void => {
	if (sslCertificates) {
		const agentOptions: Record<string, string> = {};
		if (sslCertificates.ca) agentOptions.ca = formatPrivateKey(sslCertificates.ca);
		if (sslCertificates.cert) agentOptions.cert = formatPrivateKey(sslCertificates.cert);
		if (sslCertificates.key) agentOptions.key = formatPrivateKey(sslCertificates.key);
		if (sslCertificates.passphrase)
			agentOptions.passphrase = formatPrivateKey(sslCertificates.passphrase);
		requestOptions.agentOptions = agentOptions;
	}
};

// ─── updadeQueryParameterConfig ─────────────────────────────────────────────

export const updadeQueryParameterConfig = (version: number) => {
	if (version < 4.3) {
		return (qs: IDataObject, name: string, value: string) => {
			qs[name] = value;
		};
	}
	return (qs: Record<string, unknown>, name: string, value: unknown) => {
		if (qs[name] === undefined) {
			qs[name] = value;
		} else if (Array.isArray(qs[name])) {
			(qs[name] as unknown[]).push(value);
		} else {
			qs[name] = [qs[name], value];
		}
	};
};

// ─── setFilename ────────────────────────────────────────────────────────────

export const setFilename = (
	preparedBinaryData: IBinaryData,
	requestOptions: IRequestOptions,
	responseFileName: string | undefined,
): string | undefined => {
	if (
		!preparedBinaryData.fileName &&
		preparedBinaryData.fileExtension &&
		typeof requestOptions.uri === 'string' &&
		requestOptions.uri.endsWith(preparedBinaryData.fileExtension)
	) {
		return requestOptions.uri.split('/').pop();
	}
	if (!preparedBinaryData.fileName && preparedBinaryData.fileExtension) {
		return `${responseFileName ?? 'data'}.${preparedBinaryData.fileExtension}`;
	}
	return preparedBinaryData.fileName;
};

// ─── mimeTypeFromResponse ───────────────────────────────────────────────────

export const mimeTypeFromResponse = (
	responseContentType: string | undefined,
): string | undefined => {
	if (!responseContentType) return undefined;
	return responseContentType.split(' ')[0].split(';')[0];
};

// ─── binaryToStringWithEncodingDetection (simplified) ───────────────────────

export async function binaryToStringWithEncodingDetection(
	body: Buffer | NodeJS.ReadableStream,
	contentType: string,
	helpers: { binaryToBuffer: (body: Buffer | NodeJS.ReadableStream) => Promise<Buffer>; binaryToString: (body: Buffer, encoding?: string) => Promise<string> },
): Promise<string> {
	let bufferedData: Buffer;
	if (Buffer.isBuffer(body)) {
		bufferedData = body;
	} else {
		bufferedData = await helpers.binaryToBuffer(body);
	}

	const charsetMatch = contentType.match(/charset=([^;,\s]+)/i);
	if (charsetMatch) {
		const encoding = charsetMatch[1].toLowerCase().replace(/['"]/g, '');
		if (encoding && encoding !== 'utf-8') {
			return await helpers.binaryToString(bufferedData, encoding);
		}
	}

	return await helpers.binaryToString(bufferedData);
}

// ─── configureResponseOptimizer (no-op in community node context) ───────────

export const configureResponseOptimizer = (
	_ctx: unknown,
	_itemIndex: number,
): ((x: unknown) => unknown) => {
	return (x: unknown) => x;
};
