import set from 'lodash/set';
import type {
	IBinaryKeyData,
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IRequestOptionsSimplified,
	PaginationOptions,
	JsonObject,
	IRequestOptions,
	IHttpRequestMethods,
} from 'n8n-workflow';
import {
	BINARY_ENCODING,
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	jsonParse,
	removeCircularRefs,
	sleep,
	ensureError,
} from 'n8n-workflow';
import type { Readable } from 'stream';

import { mainProperties } from './Description';
import {
	keysToLowercase,
	replaceNullValues,
	binaryContentTypes,
	getOAuth2AdditionalParameters,
	getSecrets,
	prepareRequestBody,
	reduceAsync,
	sanitizeUiMessage,
	setAgentOptions,
	updadeQueryParameterConfig,
	setFilename,
	mimeTypeFromResponse,
	binaryToStringWithEncodingDetection,
	configureResponseOptimizer,
} from './helpers';
import type { BodyParameter, IAuthDataSanitizeKeys, HttpSslAuthCredentials } from './helpers';

/**
 * Converts any data type to text representation
 * Stringifies objects/arrays, returns primitives as-is
 */
function toText<T>(data: T) {
	if (typeof data === 'object' && data !== null) {
		return JSON.stringify(data);
	}
	return data;
}
/**
 * Parses JSON string and throws descriptive error if invalid
 * Used for parsing JSON body, query params, and headers
 */
function parseJsonParameter(
	node: INode,
	jsonString: string,
	fieldName: string,
	itemIndex: number,
): IDataObject {
	try {
		return JSON.parse(jsonString) as IDataObject;
	} catch (e) {
		const error = ensureError(e);
		throw new NodeOperationError(node, `The value in the "${fieldName}" field is not valid JSON`, {
			itemIndex,
			description: error.message,
		});
	}
}

/**
 * Validates whether a URL's hostname is in the allowed domains list
 * Supports exact matches and subdomains (e.g., 'example.com' allows 'sub.example.com')
 */
function isDomainAllowedLocal(url: string, opts: { allowedDomains: string }): boolean {
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

export class BetterHttpRequest implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Better HTTP Request',
		name: 'betterHttpRequest',
		icon: 'file:betterhttp.svg',
		group: ['output'],
		subtitle: '={{$parameter["method"] + ": " + $parameter["url"]}}',
		version: 1,
		defaults: {
			name: 'Better HTTP Request',
			color: '#0004F5',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'httpSslAuth',
				required: true,
				displayOptions: {
					show: {
						provideSslCertificates: [true],
					},
				},
			},
		],
		description: 'Enhanced HTTP Request with retry-only-failed-items support',
		properties: mainProperties,
	};

	/**
	 * Main execution function that processes HTTP requests for all input items
	 * Handles authentication, request building, concurrent execution, and retry logic
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Get all input items to process
		const items = this.getInputData();
		// Node version determines API behavior (e.g., redirect handling)
		const nodeVersion = this.getNode().typeVersion;

		// Properties included in full response mode
		const fullResponseProperties = ['body', 'headers', 'statusCode', 'statusMessage'];

		// Determine authentication method: predefined (e.g., OAuth), generic (Basic, Bearer, etc.), or none
		let authentication: 'predefinedCredentialType' | 'genericCredentialType' | 'none' | undefined;
		try {
			authentication = this.getNodeParameter('authentication', 0) as
				| 'predefinedCredentialType'
				| 'genericCredentialType'
				| 'none';
		} catch {}

		// Credential variables for different authentication types
		let httpBasicAuth: IDataObject | undefined;
		let httpBearerAuth: IDataObject | undefined;
		let httpDigestAuth: IDataObject | undefined;
		let httpHeaderAuth: IDataObject | undefined;
		let httpQueryAuth: IDataObject | undefined;
		let httpCustomAuth: IDataObject | undefined;
		let oAuth1Api: IDataObject | undefined;
		let oAuth2Api: IDataObject | undefined;
		let sslCertificates: HttpSslAuthCredentials | undefined;
		let nodeCredentialType: string | undefined;
		let genericCredentialType: string | undefined;

		let requestOptions: IRequestOptions = {
			uri: '',
		};

		// Results collection and error tracking
		let returnItems: INodeExecutionData[] = [];
		// Store errors encountered during request building phase
		const errorItems: { [key: string]: string } = {};
		// Max concurrent requests to prevent overwhelming the system
		const MAX_CONCURRENT_REQUESTS = 10;
		// Response executors for concurrent execution with Promise.allSettled
		const requestExecutors: Array<(() => Promise<any>) | undefined> = new Array(items.length);

		// Response formatting flags
		let fullResponse = false;
		let autoDetectResponseFormat = false;
		let responseFileName: string | undefined;

		// Pagination configuration for handling API pagination scenarios
		const pagination = this.getNodeParameter('options.pagination.pagination', 0, null, {
			rawExpressions: true,
		}) as {
			paginationMode: 'off' | 'updateAParameterInEachRequest' | 'responseContainsNextURL';
			nextURL?: string;
			parameters: {
				parameters: Array<{
					type: 'body' | 'headers' | 'qs';
					name: string;
					value: string;
				}>;
			};
			paginationCompleteWhen: 'responseIsEmpty' | 'receiveSpecificStatusCodes' | 'other';
			statusCodesWhenComplete: string;
			completeExpression: string;
			limitPagesFetched: boolean;
			maxRequests: number;
			requestInterval: number;
		} | null;

		// Store prepared request options for each item (needed for retries and logging)
		const requests: Array<
			| {
				options: IRequestOptions;
				authKeys: IAuthDataSanitizeKeys;
				credentialType?: string;
			}
			| undefined
		> = new Array(items.length);

		// Get query parameter update function based on node version
		const updadeQueryParameter = updadeQueryParameterConfig(nodeVersion);

		// === BUILD PHASE: Process each item and prepare request executors ===
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				// === Credential Handling: Load appropriate auth credentials ===
				if (authentication === 'genericCredentialType') {
					genericCredentialType = this.getNodeParameter('genericAuthType', 0) as string;

					if (genericCredentialType === 'httpBasicAuth') {
						httpBasicAuth = await this.getCredentials<IDataObject>('httpBasicAuth', itemIndex);
					} else if (genericCredentialType === 'httpBearerAuth') {
						httpBearerAuth = await this.getCredentials<IDataObject>('httpBearerAuth', itemIndex);
					} else if (genericCredentialType === 'httpDigestAuth') {
						httpDigestAuth = await this.getCredentials<IDataObject>('httpDigestAuth', itemIndex);
					} else if (genericCredentialType === 'httpHeaderAuth') {
						httpHeaderAuth = await this.getCredentials<IDataObject>('httpHeaderAuth', itemIndex);
					} else if (genericCredentialType === 'httpQueryAuth') {
						httpQueryAuth = await this.getCredentials<IDataObject>('httpQueryAuth', itemIndex);
					} else if (genericCredentialType === 'httpCustomAuth') {
						httpCustomAuth = await this.getCredentials<IDataObject>('httpCustomAuth', itemIndex);
					} else if (genericCredentialType === 'oAuth1Api') {
						oAuth1Api = await this.getCredentials<IDataObject>('oAuth1Api', itemIndex);
					} else if (genericCredentialType === 'oAuth2Api') {
						oAuth2Api = await this.getCredentials<IDataObject>('oAuth2Api', itemIndex);
					}
				} else if (authentication === 'predefinedCredentialType') {
					nodeCredentialType = this.getNodeParameter(
						'nodeCredentialType',
						itemIndex,
					) as string;
				}

				// === URL Validation ===
				const url = this.getNodeParameter('url', itemIndex);

				// Ensure URL is string type
				if (typeof url !== 'string') {
					const actualType = url === null ? 'null' : typeof url;
					throw new NodeOperationError(
						this.getNode(),
						`URL parameter must be a string, got ${actualType}`,
					);
				}

				// Ensure URL uses http/https protocol
				if (!url.startsWith('http://') && !url.startsWith('https://')) {
					throw new NodeOperationError(
						this.getNode(),
						`Invalid URL: ${url}. URL must start with "http" or "https".`,
					);
				}

				// === Domain Restriction Validation ===
				// Helper function to check if credential allows access to requested URL
				const checkDomainRestrictions = async (
					credentialData: IDataObject,
					requestUrl: string,
					credentialType?: string,
				) => {
					if (credentialData.allowedHttpRequestDomains === 'domains') {
						const allowedDomains = credentialData.allowedDomains as string;
						if (!allowedDomains || allowedDomains.trim() === '') {
							throw new NodeOperationError(
								this.getNode(),
								'No allowed domains specified. Configure allowed domains or change restriction setting.',
							);
						}
						if (!isDomainAllowedLocal(requestUrl, { allowedDomains })) {
							const credentialInfo = credentialType ? ` (${credentialType})` : '';
							throw new NodeOperationError(
								this.getNode(),
								`Domain not allowed: This credential${credentialInfo} is restricted from accessing ${requestUrl}. ` +
									`Only the following domains are allowed: ${allowedDomains}`,
							);
						}
					} else if (credentialData.allowedHttpRequestDomains === 'none') {
						throw new NodeOperationError(
							this.getNode(),
							'This credential is configured to prevent use within an HTTP Request node',
						);
					}
				};

				if (httpBasicAuth) await checkDomainRestrictions(httpBasicAuth, url);
				if (httpBearerAuth) await checkDomainRestrictions(httpBearerAuth, url);
				if (httpDigestAuth) await checkDomainRestrictions(httpDigestAuth, url);
				if (httpHeaderAuth) await checkDomainRestrictions(httpHeaderAuth, url);
				if (httpQueryAuth) await checkDomainRestrictions(httpQueryAuth, url);
				if (httpCustomAuth) await checkDomainRestrictions(httpCustomAuth, url);
				if (oAuth1Api) await checkDomainRestrictions(oAuth1Api, url);
				if (oAuth2Api) await checkDomainRestrictions(oAuth2Api, url);

				if (nodeCredentialType) {
					try {
						const credentialData = await this.getCredentials(nodeCredentialType, itemIndex);
						await checkDomainRestrictions(credentialData, url, nodeCredentialType);
					} catch (error: any) {
						if (
							error.message?.includes('Domain not allowed') ||
							error.message?.includes('configured to prevent') ||
							error.message?.includes('No allowed domains specified')
						) {
							throw error;
						}
					}
				}

				// === SSL Certificate Configuration ===
				const provideSslCertificates = this.getNodeParameter(
					'provideSslCertificates',
					itemIndex,
					false,
				);
				if (provideSslCertificates) {
					sslCertificates = (await this.getCredentials(
						'httpSslAuth',
						itemIndex,
					)) as unknown as HttpSslAuthCredentials;
				}

				// === Request Method & Query Parameters ===
				const requestMethod = this.getNodeParameter(
					'method',
					itemIndex,
				) as IHttpRequestMethods;

				const sendQuery = this.getNodeParameter('sendQuery', itemIndex, false) as boolean;
				const queryParameters = this.getNodeParameter(
					'queryParameters.parameters',
					itemIndex,
					[],
				) as Array<{ name: string; value: string }>;
				const specifyQuery = this.getNodeParameter(
					'specifyQuery',
					itemIndex,
					'keypair',
				) as string;
				const jsonQueryParameter = this.getNodeParameter(
					'jsonQuery',
					itemIndex,
					'',
				) as string;

				// === Request Body Configuration ===
				const sendBody = this.getNodeParameter('sendBody', itemIndex, false) as boolean;
				const bodyContentType = this.getNodeParameter(
					'contentType',
					itemIndex,
					'',
				) as string;
				const specifyBody = this.getNodeParameter('specifyBody', itemIndex, '') as string;
				const bodyParameters = this.getNodeParameter(
					'bodyParameters.parameters',
					itemIndex,
					[],
				) as BodyParameter[];
				const jsonBodyParameter = this.getNodeParameter(
					'jsonBody',
					itemIndex,
					'',
				) as string;
				const body = this.getNodeParameter('body', itemIndex, '') as string;

				// === Request Headers Configuration ===
				const sendHeaders = this.getNodeParameter(
					'sendHeaders',
					itemIndex,
					false,
				) as boolean;
				const headerParameters = this.getNodeParameter(
					'headerParameters.parameters',
					itemIndex,
					[],
				) as Array<{ name: string; value: string }>;
				const specifyHeaders = this.getNodeParameter(
					'specifyHeaders',
					itemIndex,
					'keypair',
				) as string;
				const jsonHeadersParameter = this.getNodeParameter(
					'jsonHeaders',
					itemIndex,
					'',
				) as string;

				// === Advanced Request Options ===
				// Extract options for redirects, batching, proxy, timeouts, and response handling
				const {
					redirect,
					batching,
					proxy,
					timeout,
					allowUnauthorizedCerts,
					queryParameterArrays,
					response,
					lowercaseHeaders,
					sendCredentialsOnCrossOriginRedirect,
				} = this.getNodeParameter('options', itemIndex, {}) as {
					batching: { batch: { batchSize: number; batchInterval: number } };
					proxy: string;
					timeout: number;
					allowUnauthorizedCerts: boolean;
					queryParameterArrays: 'indices' | 'brackets' | 'repeat';
					response: {
						response: {
							neverError: boolean;
							responseFormat: string;
							fullResponse: boolean;
							outputPropertyName: string;
						};
					};
					redirect: { redirect: { maxRedirects: number; followRedirects: boolean } };
					lowercaseHeaders: boolean;
					sendCredentialsOnCrossOriginRedirect?: boolean;
				};

				// Extract response formatting configuration
				responseFileName = response?.response?.outputPropertyName;
				const responseFormat = response?.response?.responseFormat || 'autodetect';
				fullResponse = response?.response?.fullResponse || false;
				autoDetectResponseFormat = responseFormat === 'autodetect';

				// Configure batch size and interval for rate limiting
				const batchSize =
					batching?.batch?.batchSize > 0 ? batching?.batch?.batchSize : 1;
				const batchInterval = batching?.batch?.batchInterval;

				// Apply delay between batches if configured (rate limiting)
				if (itemIndex > 0 && batchSize >= 0 && batchInterval > 0) {
					if (itemIndex % batchSize === 0) {
						await sleep(batchInterval);
					}
				}

				// === Initialize Request Options ===
				// Base configuration for HTTP request
				requestOptions = {
					headers: {},
					method: requestMethod,
					uri: url,
					gzip: true,
					rejectUnauthorized: !allowUnauthorizedCerts || false,
					followRedirect: false,
					resolveWithFullResponse: true,
					sendCredentialsOnCrossOriginRedirect:
						sendCredentialsOnCrossOriginRedirect ?? false,
				};

				if (requestOptions.method !== 'GET' && nodeVersion >= 4.1) {
					requestOptions = { ...requestOptions, followAllRedirects: false };
				}

				const defaultRedirect = redirect === undefined;

				if (redirect?.redirect?.followRedirects || defaultRedirect) {
					requestOptions.followRedirect = true;
					requestOptions.followAllRedirects = true;
				}
				if (redirect?.redirect?.maxRedirects || defaultRedirect) {
					requestOptions.maxRedirects = redirect?.redirect?.maxRedirects;
				}

				if (response?.response?.neverError) {
					requestOptions.simple = false;
				}

				if (proxy) {
					requestOptions.proxy = proxy;
				}
				if (timeout) {
					requestOptions.timeout = timeout;
				} else {
					requestOptions.timeout = 300_000;
				}

				if (sendQuery && queryParameterArrays) {
					Object.assign(requestOptions, {
						qsStringifyOptions: { arrayFormat: queryParameterArrays },
					});
				}

				// === Parameter Processing Helper ===
				// Converts parameters to key-value format, handles binary data uploads
				const parametersToKeyValue = async (
					accumulator: { [key: string]: any },
					cur: {
						name: string;
						value: string;
						parameterType?: string;
						inputDataFieldName?: string;
					},
				) => {
					if (cur.parameterType === 'formBinaryData') {
						if (!cur.inputDataFieldName) return accumulator;
						const binaryData = this.helpers.assertBinaryData(
							itemIndex,
							cur.inputDataFieldName,
						);
						let uploadData: Buffer | Readable;
						if (binaryData.id) {
							uploadData = await this.helpers.getBinaryStream(binaryData.id);
						} else {
							uploadData = Buffer.from(binaryData.data, BINARY_ENCODING);
						}
						accumulator[cur.name] = {
							value: uploadData,
							options: {
								filename: binaryData.fileName,
								contentType: binaryData.mimeType,
							},
						};
						return accumulator;
					}
					updadeQueryParameter(accumulator, cur.name, cur.value);
					return accumulator;
				};

				// === Build Request Body ===
				if (sendBody && bodyParameters) {
					if (specifyBody === 'keypair' || bodyContentType === 'multipart-form-data') {
						requestOptions.body = await prepareRequestBody(
							bodyParameters,
							bodyContentType,
							nodeVersion,
							parametersToKeyValue,
						);
					} else if (specifyBody === 'json') {
						if (
							typeof jsonBodyParameter !== 'object' &&
							jsonBodyParameter !== null
						) {
							requestOptions.body = parseJsonParameter(
								this.getNode(),
								jsonBodyParameter,
								'JSON Body',
								itemIndex,
							);
						} else {
							requestOptions.body = jsonBodyParameter;
						}
					} else if (specifyBody === 'string') {
						requestOptions.body = Object.fromEntries(
							new URLSearchParams(body),
						);
					}
				}

				if (sendBody && ['PATCH', 'POST', 'PUT', 'GET'].includes(requestMethod)) {
					if (bodyContentType === 'multipart-form-data') {
						requestOptions.formData = requestOptions.body as IDataObject;
						delete requestOptions.body;
					} else if (bodyContentType === 'form-urlencoded') {
						requestOptions.form = requestOptions.body as IDataObject;
						delete requestOptions.body;
					} else if (bodyContentType === 'binaryData') {
						const inputDataFieldName = this.getNodeParameter(
							'inputDataFieldName',
							itemIndex,
						) as string;
						let uploadData: Buffer | Readable;
						let contentLength: number;
						const itemBinaryData = this.helpers.assertBinaryData(
							itemIndex,
							inputDataFieldName,
						);
						if (itemBinaryData.id) {
							uploadData = await this.helpers.getBinaryStream(itemBinaryData.id);
							const metadata = await this.helpers.getBinaryMetadata(
								itemBinaryData.id,
							);
							contentLength = metadata.fileSize;
						} else {
							uploadData = Buffer.from(itemBinaryData.data, BINARY_ENCODING);
							contentLength = uploadData.length;
						}
						requestOptions.body = uploadData;
						requestOptions.headers = {
							...requestOptions.headers,
							'content-length': contentLength,
							'content-type':
								itemBinaryData.mimeType ?? 'application/octet-stream',
						};
					} else if (bodyContentType === 'raw') {
						requestOptions.body = body;
					}
				}

				// === Build Query String Parameters ===
				if (sendQuery && queryParameters) {
					if (specifyQuery === 'keypair') {
						requestOptions.qs = await reduceAsync(
							queryParameters,
							parametersToKeyValue,
						);
					} else if (specifyQuery === 'json') {
						requestOptions.qs = parseJsonParameter(
							this.getNode(),
							jsonQueryParameter,
							'JSON Query Parameters',
							itemIndex,
						);
					}
				}

				// === Build Custom Request Headers ===
				if (sendHeaders && headerParameters) {
					let additionalHeaders: IDataObject = {};
					if (specifyHeaders === 'keypair') {
						additionalHeaders = await reduceAsync(
							headerParameters.filter((header) => header.name),
							parametersToKeyValue,
						);
					} else if (specifyHeaders === 'json') {
						additionalHeaders = parseJsonParameter(
							this.getNode(),
							jsonHeadersParameter,
							'JSON Headers',
							itemIndex,
						);
					}
					requestOptions.headers = {
						...requestOptions.headers,
						...(lowercaseHeaders === undefined || lowercaseHeaders
							? keysToLowercase(additionalHeaders)
							: additionalHeaders),
					};
				}

				// === Configure Response Encoding ===
				// For file/binary responses, use streaming; for JSON, parse automatically
				if (autoDetectResponseFormat || responseFormat === 'file') {
					requestOptions.encoding = null;
					requestOptions.json = false;
					requestOptions.useStream = true;
				} else if (bodyContentType === 'raw') {
					requestOptions.json = false;
					requestOptions.useStream = true;
				} else {
					requestOptions.json = true;
				}

				if (bodyContentType === 'raw') {
					if (requestOptions.headers === undefined) {
						requestOptions.headers = {};
					}
					const rawContentType = this.getNodeParameter(
						'rawContentType',
						itemIndex,
					) as string;
					requestOptions.headers['content-type'] = rawContentType;
				}

				const authDataKeys: IAuthDataSanitizeKeys = {};
				// === Attach Authentication to Request ===
				// Configure SSL/TLS options if provided
				setAgentOptions(requestOptions, sslCertificates);
				if (requestOptions.agentOptions) {
					authDataKeys.agentOptions = Object.keys(requestOptions.agentOptions);
				}

				// Attach appropriate authentication method to request
				if (httpBasicAuth !== undefined) {
					requestOptions.auth = {
						user: httpBasicAuth.user as string,
						pass: httpBasicAuth.password as string,
					};
					authDataKeys.auth = ['pass'];
				}
				if (httpBearerAuth !== undefined) {
					requestOptions.headers = requestOptions.headers ?? {};
					requestOptions.headers.Authorization = `Bearer ${String(
						httpBearerAuth.token,
					)}`;
					authDataKeys.headers = ['Authorization'];
				}
				if (httpHeaderAuth !== undefined) {
					requestOptions.headers![httpHeaderAuth.name as string] =
						httpHeaderAuth.value;
					authDataKeys.headers = [httpHeaderAuth.name as string];
				}
				if (httpQueryAuth !== undefined) {
					if (!requestOptions.qs) {
						requestOptions.qs = {};
					}
					requestOptions.qs[httpQueryAuth.name as string] = httpQueryAuth.value;
					authDataKeys.qs = [httpQueryAuth.name as string];
				}
				if (httpDigestAuth !== undefined) {
					requestOptions.auth = {
						user: httpDigestAuth.user as string,
						pass: httpDigestAuth.password as string,
						sendImmediately: false,
					};
					authDataKeys.auth = ['pass'];
				}
				if (httpCustomAuth !== undefined) {
					const customAuth = jsonParse<IRequestOptionsSimplified>(
						(httpCustomAuth.json as string) || '{}',
						{ errorMessage: 'Invalid Custom Auth JSON' },
					);
					if (customAuth.headers) {
						requestOptions.headers = {
							...requestOptions.headers,
							...customAuth.headers,
						};
						authDataKeys.headers = Object.keys(customAuth.headers);
					}
					if (customAuth.body) {
						requestOptions.body = {
							...(requestOptions.body as IDataObject),
							...customAuth.body,
						};
						authDataKeys.body = Object.keys(customAuth.body);
					}
					if (customAuth.qs) {
						requestOptions.qs = { ...requestOptions.qs, ...customAuth.qs };
						authDataKeys.qs = Object.keys(customAuth.qs);
					}
				}

				if (requestOptions.headers!.accept === undefined) {
					if (responseFormat === 'json') {
						requestOptions.headers!.accept = 'application/json,text/*;q=0.99';
					} else if (responseFormat === 'text') {
						requestOptions.headers!.accept =
							'application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, */*;q=0.1';
					} else {
						requestOptions.headers!.accept =
							'application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7';
					}
				}

				const itemRequestOptions = requestOptions;

				requests[itemIndex] = {
					options: itemRequestOptions,
					authKeys: authDataKeys,
					credentialType: nodeCredentialType,
				};

				if (pagination && pagination.paginationMode !== 'off') {
					let continueExpression = '={{false}}';
					if (
						pagination.paginationCompleteWhen === 'receiveSpecificStatusCodes'
					) {
						const statusCodesWhenCompleted = pagination.statusCodesWhenComplete
							.split(',')
							.map((item) => parseInt(item.trim()));
						continueExpression = `={{ !${JSON.stringify(
							statusCodesWhenCompleted,
						)}.includes($response.statusCode) }}`;
					} else if (
						pagination.paginationCompleteWhen === 'responseIsEmpty'
					) {
						continueExpression =
							'={{ Array.isArray($response.body) ? $response.body.length : !!$response.body }}';
					} else {
						if (
							!pagination.completeExpression.length ||
							pagination.completeExpression[0] !== '='
						) {
							throw new NodeOperationError(
								this.getNode(),
								'Invalid or empty Complete Expression',
							);
						}
						const completionExpression = pagination.completeExpression
							.trim()
							.slice(3, -2);
						if (response?.response?.neverError) {
							continueExpression = `={{ !(${completionExpression}) }}`;
						} else {
							continueExpression = `={{ !(${completionExpression}) || ($response.statusCode < 200 || $response.statusCode >= 300) }}`;
						}
					}

					const paginationData: PaginationOptions = {
						continue: continueExpression,
						request: {},
						requestInterval: pagination.requestInterval,
					};

					if (
						pagination.paginationMode ===
						'updateAParameterInEachRequest'
					) {
						paginationData.request = {};
						const { parameters } = pagination.parameters;
						if (
							parameters.length === 1 &&
							parameters[0].name === '' &&
							parameters[0].value === ''
						) {
							throw new NodeOperationError(
								this.getNode(),
								"At least one entry with 'Name' and 'Value' filled must be included in 'Parameters' to use 'Update a Parameter in Each Request' mode ",
							);
						}
						pagination.parameters.parameters.forEach(
							(parameter, index) => {
								if (!paginationData.request[parameter.type]) {
									paginationData.request[parameter.type] = {};
								}
								const parameterName = parameter.name;
								if (parameterName === '') {
									throw new NodeOperationError(
										this.getNode(),
										`Parameter name must be set for parameter [${
											index + 1
										}] in pagination settings`,
									);
								}
								const parameterValue = parameter.value;
								if (parameterValue === '') {
									throw new NodeOperationError(
										this.getNode(),
										`Some value must be provided for parameter [${
											index + 1
										}] in pagination settings, omitting it will result in an infinite loop`,
									);
								}
								paginationData.request[parameter.type]![
									parameterName
								] = parameterValue;
							},
						);
					} else if (
						pagination.paginationMode === 'responseContainsNextURL'
					) {
						paginationData.request.url = pagination.nextURL;
					}

					if (pagination.limitPagesFetched) {
						paginationData.maxRequests = pagination.maxRequests;
					}
					if (responseFormat === 'file') {
						paginationData.binaryResult = true;
					}

					requestExecutors[itemIndex] = async () => {
						return await this.helpers.requestWithAuthenticationPaginated
							.call(
								this,
								itemRequestOptions,
								itemIndex,
								paginationData,
								nodeCredentialType ?? genericCredentialType,
							)
							.catch((error: any) => {
								if (
									error instanceof NodeOperationError &&
									error.type === 'invalid_url'
								) {
									const urlParameterName =
										pagination.paginationMode ===
										'responseContainsNextURL'
											? 'Next URL'
											: 'URL';
									throw new NodeOperationError(
										this.getNode(),
										error.message,
										{
											description: `Make sure the "${urlParameterName}" parameter evaluates to a valid URL.`,
										},
									);
								}
								throw error;
							});
					};
				} else if (
					authentication === 'genericCredentialType' ||
					authentication === 'none'
				) {
					if (oAuth1Api) {
						requestExecutors[itemIndex] = async () =>
							await this.helpers.requestOAuth1.call(
								this,
								'oAuth1Api',
								itemRequestOptions,
							);
					} else if (oAuth2Api) {
						requestExecutors[itemIndex] = async () =>
							await this.helpers.requestOAuth2.call(
								this,
								'oAuth2Api',
								itemRequestOptions,
								{ tokenType: 'Bearer' },
							);
					} else {
						requestExecutors[itemIndex] = async () =>
							await this.helpers.request(itemRequestOptions);
					}
				} else if (
					authentication === 'predefinedCredentialType' &&
					nodeCredentialType
				) {
					const credentialType = nodeCredentialType;
					const additionalOAuth2Options =
						getOAuth2AdditionalParameters(credentialType);
					requestExecutors[itemIndex] = async () =>
						await this.helpers.requestWithAuthentication.call(
							this,
							credentialType,
							itemRequestOptions,
							additionalOAuth2Options && {
								oauth2: additionalOAuth2Options,
							},
							itemIndex,
						);
				}
			} catch (error) {
				if (!this.continueOnFail()) throw error;
				errorItems[itemIndex] = (error as Error).message;
				continue;
			}
		}

// === EXECUTION PHASE: Execute all requests concurrently ===
		const sanitizedRequests: Array<IDataObject | undefined> = new Array(items.length);
		const promisesResponses: Array<PromiseSettledResult<any>> = new Array(items.length);
		// Track in-flight tasks to manage concurrency (max 10 concurrent requests)
		const inFlightTasks = new Set<Promise<void>>();

		// Progress tracking for UI updates
		let completedCount = 0;
		const totalCount = items.length;

		const reportProgress = () => {
			const percentage = Math.round((completedCount / totalCount) * 100);
			this.sendMessageToUI({
				type: 'progress',
				message: `${percentage}% complete (${completedCount}/${totalCount} items)`,
				percentage,
				completed: completedCount,
				total: totalCount,
			});
		};

		// === Request Execution Helper ===
		// Executes request and tracks progress/sanitization
		const executeRequestWithTracking = async (
			itemIndex: number,
			executor: () => Promise<any>,
		): Promise<void> => {
			try {
				const value = await executor();
				promisesResponses[itemIndex] = {
					status: 'fulfilled',
					value,
				};
			} catch (reason) {
				promisesResponses[itemIndex] = {
					status: 'rejected',
					reason,
				};
			} finally {
				if (errorItems[itemIndex]) return;
				try {
					const requestData = requests[itemIndex];
					if (!requestData) return;

					const { options, authKeys, credentialType } = requestData;
					let secrets: string[] = [];
					if (credentialType) {
						const properties = this.getCredentialsProperties(credentialType);
						const credentials = await this.getCredentials(
							credentialType,
							itemIndex,
						);
						secrets = getSecrets(properties, credentials);
					}
					const sanitizedRequestOptions = sanitizeUiMessage(
						options,
						authKeys,
						secrets,
					);
					sanitizedRequests[itemIndex] = sanitizedRequestOptions;
					this.sendMessageToUI(sanitizedRequestOptions);
				} catch {}

				// Report progress
				completedCount++;
				reportProgress();
			}
		};

		// === Queue Request Execution ===
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			// Skip items with build-phase errors
			if (errorItems[itemIndex]) {
				promisesResponses[itemIndex] = {
					status: 'fulfilled',
					value: undefined,
				};
				continue;
			}

			const executor = requestExecutors[itemIndex];
		if (!executor) {
			promisesResponses[itemIndex] = {
				status: 'fulfilled',
				value: undefined,
			};
			continue;
		}

			// If max concurrent requests reached, wait for one to complete
			while (inFlightTasks.size >= MAX_CONCURRENT_REQUESTS) {
				await Promise.race(inFlightTasks);
			}

			// Queue task for execution
			let task: Promise<void>;
			task = executeRequestWithTracking(itemIndex, executor).finally(() => {
				inFlightTasks.delete(task);
			});
			inFlightTasks.add(task);
	}

		// === Wait for all requests to complete ===
		if (inFlightTasks.size > 0) {
			await Promise.all(inFlightTasks);
		}

		// === RESPONSE PROCESSING PHASE: Process results and build output ===
		let responseData: any;
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				responseData = promisesResponses[itemIndex];

				if (errorItems[itemIndex]) {
					returnItems.push({
						json: { error: errorItems[itemIndex] },
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (responseData!.status !== 'fulfilled') {
					if (responseData.reason.statusCode === 429) {
						responseData.reason.message =
							"Try spacing your requests out using the batching settings under 'Options'";
					}
					if (!this.continueOnFail()) {
						if (
							autoDetectResponseFormat &&
							responseData.reason.error instanceof Buffer
						) {
							responseData.reason.error = Buffer.from(
								responseData.reason.error as Buffer,
							).toString();
						}
						let error;
						if (responseData?.reason instanceof NodeApiError) {
							error = responseData.reason;
							set(error, 'context.itemIndex', itemIndex);
						} else {
							const errorData = (
								responseData.reason
									? responseData.reason
									: responseData
							) as JsonObject;
							error = new NodeApiError(this.getNode(), errorData, {
								itemIndex,
							});
						}
						set(
							error,
							'context.request',
							sanitizedRequests[itemIndex],
						);
						throw error;
					} else {
						// Safely serialize error to avoid circular references from socket/request objects
						const reason = responseData.reason;
						let safeError: any;
						if (reason instanceof Error) {
							safeError = {
								message: reason.message,
								name: reason.name,
								...((reason as any).statusCode !== undefined ? { statusCode: (reason as any).statusCode } : {}),
								...((reason as any).httpCode !== undefined ? { httpCode: (reason as any).httpCode } : {}),
								...((reason as any).code !== undefined ? { code: (reason as any).code } : {}),
								...((reason as any).description !== undefined ? { description: (reason as any).description } : {}),
								...((reason as any).headers ? { headers: (reason as any).headers } : {}),
								...((reason as any).response?.headers ? { response: { headers: (reason as any).response.headers } } : {}),
							};
						} else if (typeof reason === 'object' && reason !== null) {
							try {
								removeCircularRefs(reason as JsonObject);
								safeError = reason;
							} catch {
								safeError = { message: String(reason) };
							}
						} else {
							safeError = { message: String(reason) };
						}
						returnItems.push({
							json: { error: safeError },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
				}

				let responses: any[];
				if (Array.isArray(responseData.value)) {
					responses = responseData.value;
				} else {
					responses = [responseData.value];
				}

				let responseFormat = this.getNodeParameter(
					'options.response.response.responseFormat',
					0,
					'autodetect',
				) as string;

				fullResponse = this.getNodeParameter(
					'options.response.response.fullResponse',
					0,
					false,
				) as boolean;

				for (let [index, response] of Object.entries(responses) as Array<[string, any]>) {
					if (
						response?.request?.constructor.name === 'ClientRequest'
					)
						delete response.request;

					if (this.getMode() === 'manual' && index === '0') {
						const nodeContext = this.getContext('node');
						if (pagination && pagination.paginationMode !== 'off') {
							nodeContext.response = responseData.value[0];
						} else {
							nodeContext.response = responseData.value;
						}
					}

					const responseContentType =
						response.headers?.['content-type'] ?? '';
					if (autoDetectResponseFormat) {
						if (
							responseContentType.includes('application/json')
						) {
							responseFormat = 'json';
							if (!response.__bodyResolved) {
								const neverError = this.getNodeParameter(
									'options.response.response.neverError',
									0,
									false,
								) as boolean;
								const data =
									await binaryToStringWithEncodingDetection(
										response.body as Buffer | Readable,
										responseContentType,
										this.helpers as any,
									);
								response.body = jsonParse(data, {
									...(neverError
										? { fallbackValue: {} }
										: {
												errorMessage:
													'Invalid JSON in response body',
											}),
								});
							}
						} else if (
							binaryContentTypes.some((e) =>
								responseContentType.includes(e),
							)
						) {
							responseFormat = 'file';
						} else {
							responseFormat = 'text';
							if (!response.__bodyResolved) {
								const data =
									await binaryToStringWithEncodingDetection(
										response.body as Buffer | Readable,
										responseContentType,
										this.helpers as any,
									);
								response.body = !data ? undefined : data;
							}
						}
					}

					const optimizeResponse = configureResponseOptimizer(
						this,
						itemIndex,
					);

					if (autoDetectResponseFormat && !fullResponse) {
						delete response.headers;
						delete response.statusCode;
						delete response.statusMessage;
					}
					if (!fullResponse) {
						response = optimizeResponse(response.body);
					} else {
						response.body = optimizeResponse(response.body);
					}

					if (responseFormat === 'file') {
						const outputPropertyName = this.getNodeParameter(
							'options.response.response.outputPropertyName',
							0,
							'data',
						) as string;

						const newItem: INodeExecutionData = {
							json: {},
							binary: {},
							pairedItem: { item: itemIndex },
						};

						if (items[itemIndex].binary !== undefined) {
							Object.assign(
								newItem.binary as IBinaryKeyData,
								items[itemIndex].binary,
							);
						}

						let binaryData: Buffer | Readable;
						if (fullResponse) {
							const returnItem: IDataObject = {};
							for (const property of fullResponseProperties) {
								if (property === 'body') continue;
								returnItem[property] = response[property];
							}
							newItem.json = returnItem;
							binaryData = response?.body;
						} else {
							newItem.json = items[itemIndex].json;
							binaryData = response;
						}

						const preparedBinaryData =
							await this.helpers.prepareBinaryData(
								binaryData,
								undefined,
								mimeTypeFromResponse(responseContentType),
							);
						preparedBinaryData.fileName = setFilename(
							preparedBinaryData,
							requestOptions,
							responseFileName,
						);
						newItem.binary![outputPropertyName] =
							preparedBinaryData;
						returnItems.push(newItem);
					} else if (responseFormat === 'text') {
						const outputPropertyName = this.getNodeParameter(
							'options.response.response.outputPropertyName',
							0,
							'data',
						) as string;
						if (fullResponse) {
							const returnItem: IDataObject = {};
							for (const property of fullResponseProperties) {
								if (property === 'body') {
									returnItem[outputPropertyName] = toText(
										response[property],
									);
									continue;
								}
								returnItem[property] = response[property];
							}
							returnItems.push({
								json: returnItem,
								pairedItem: { item: itemIndex },
							});
						} else {
							returnItems.push({
								json: {
									[outputPropertyName]: toText(response),
								},
								pairedItem: { item: itemIndex },
							});
						}
					} else {
						// responseFormat: 'json'
						if (fullResponse) {
							const returnItem: IDataObject = {};
							for (const property of fullResponseProperties) {
								returnItem[property] = response[property];
							}
							if (
								responseFormat === 'json' &&
								typeof returnItem.body === 'string'
							) {
								try {
									returnItem.body = JSON.parse(
										returnItem.body,
									);
								} catch {
									throw new NodeOperationError(
										this.getNode(),
										'Response body is not valid JSON. Change "Response Format" to "Text"',
										{ itemIndex },
									);
								}
							}
							returnItems.push({
								json: returnItem,
								pairedItem: { item: itemIndex },
							});
						} else {
							if (
								responseFormat === 'json' &&
								typeof response === 'string'
							) {
								try {
									if (typeof response !== 'object') {
										response = JSON.parse(response);
									}
								} catch {
									throw new NodeOperationError(
										this.getNode(),
										'Response body is not valid JSON. Change "Response Format" to "Text"',
										{ itemIndex },
									);
								}
							}
							if (Array.isArray(response)) {
								response.forEach((item: any) =>
									returnItems.push({
										json: item,
										pairedItem: { item: itemIndex },
									}),
								);
							} else {
								returnItems.push({
									json: response,
									pairedItem: { item: itemIndex },
								});
							}
						}
					}
				}
			} catch (error) {
				if (!this.continueOnFail()) throw error;
				returnItems.push({
					json: {
						error: {
							message: (error as Error).message,
							code: (error as any).code,
							statusCode: (error as any).statusCode,
						},
					},
					pairedItem: { item: itemIndex },
				});
				continue;
			}
		}

		// ─── Retry Only Failed Items Feature ────────────────────────────────────
		// Implement retry logic for failed requests with configurable status codes
		const retryOnFail = this.getNodeParameter(
			'options.retryOnFail',
			0,
			false,
		) as boolean;

		if (retryOnFail && this.continueOnFail()) {
			// Retry settings: max attempts, delay between retries, and status codes to retry on
			const maxRetries = this.getNodeParameter(
				'options.maxRetries',
				0,
				3,
			) as number;
			const retryDelay = this.getNodeParameter(
				'options.retryDelay',
				0,
				1000,
			) as number;
			const retryOnStatusCodesStr = this.getNodeParameter(
				'options.retryOnStatusCodes',
				0,
				'429,500,502,503,504',
			) as string;
			// Parse status codes to retry on (e.g., 429=Too Many Requests, 5xx=Server Errors)
			const retryOnStatusCodes = new Set(
				retryOnStatusCodesStr
					.split(',')
					.map((s) => parseInt(s.trim(), 10))
					.filter((n) => !isNaN(n)),
			);

			// Connection error codes to retry (network-level failures)
			const retryOnErrorCodes = new Set([
				'ECONNREFUSED',
				'ECONNRESET',
				'ETIMEDOUT',
				'ENOTFOUND',
			]);

			// Retry loop: attempt up to maxRetries times
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				// Collect indices of failed items that should be retried
				const failedIndices: number[] = [];

				// Identify items with retryable errors
				for (let i = 0; i < returnItems.length; i++) {
					const item = returnItems[i];
					if (item.json && item.json.error) {
						const errObj = item.json.error;
						let statusCode: number | undefined;
						let errorCode: string | undefined;
						if (typeof errObj === 'object' && errObj !== null) {
							statusCode =
								(errObj as any).statusCode ??
								(errObj as any).httpCode;
							errorCode = (errObj as any).code;
						}
						// Check if error matches retry criteria
						if (
							(statusCode !== undefined &&
								retryOnStatusCodes.has(statusCode)) ||
							(errorCode !== undefined &&
								retryOnErrorCodes.has(errorCode))
						) {
							failedIndices.push(i);
						}
					}
				}

				// If no failures, exit retry loop
				if (failedIndices.length === 0) break;

				// === Calculate effective retry delay ===
				// Check for Retry-After header in 429 responses
				let effectiveDelay = retryDelay;
				for (const idx of failedIndices) {
					const errObj = returnItems[idx].json.error;
					if (typeof errObj === 'object' && errObj !== null) {
						const sc = (errObj as any).statusCode;
						// For rate-limited requests, respect server's Retry-After header
						if (sc === 429) {
							const retryAfterHeader =
								(errObj as any).headers?.['retry-after'] ??
								(errObj as any).response?.headers?.[
									'retry-after'
								];
							if (retryAfterHeader) {
								const retryAfterSeconds =
									parseInt(retryAfterHeader, 10);
								if (!isNaN(retryAfterSeconds)) {
									effectiveDelay = Math.max(
										effectiveDelay,
										retryAfterSeconds * 1000,
									);
								}
							}
						}
					}
				}

				// Wait before retrying
				if (effectiveDelay > 0) {
					await sleep(effectiveDelay);
				}

				// === Re-execute failed requests ===
				const retryPromises: Array<{
					index: number;
					promise: Promise<any>;
				}> = [];

				// Queue retry requests for failed items
				for (const idx of failedIndices) {
					const originalItemIndex =
						returnItems[idx].pairedItem &&
						typeof returnItems[idx].pairedItem === 'object' &&
						!Array.isArray(returnItems[idx].pairedItem)
							? (returnItems[idx].pairedItem as { item: number })
									.item
							: idx;

					// Re-execute the original request for this item
					if (requests[originalItemIndex]) {
						const { options } = requests[originalItemIndex];
						const retryRequest = this.helpers
							.request(options)
							.catch(() => {});
						retryPromises.push({
							index: idx,
							promise: retryRequest,
						});
					}
				}

				// Wait for all retry requests to settle
				const retryResults = await Promise.allSettled(
					retryPromises.map((r) => r.promise),
				);

				// === Process retry results and update return items ===
				for (let ri = 0; ri < retryResults.length; ri++) {
					const result = retryResults[ri];
					const idx = retryPromises[ri].index;
					const originalItemIndex =
						returnItems[idx].pairedItem &&
						typeof returnItems[idx].pairedItem === 'object' &&
						!Array.isArray(returnItems[idx].pairedItem)
							? (returnItems[idx].pairedItem as { item: number })
									.item
							: idx;

					// If retry succeeded, process the new response
					if (result.status === 'fulfilled' && result.value != null) {
						const response = result.value;
						// Successfully retried - process the response
						if (
							typeof response === 'object' &&
							response !== null &&
							response.body !== undefined
						) {
							// Full response object
							let responseFormat = this.getNodeParameter(
								'options.response.response.responseFormat',
								0,
								'autodetect',
							) as string;
							const currentFullResponse = this.getNodeParameter(
								'options.response.response.fullResponse',
								0,
								false,
							) as boolean;

							if (responseFormat === 'autodetect') {
								const ct =
									response.headers?.['content-type'] ?? '';
								if (ct.includes('application/json')) {
									responseFormat = 'json';
								} else {
									responseFormat = 'text';
								}
							}

							if (currentFullResponse) {
								returnItems[idx] = {
									json: {
										body:
											typeof response.body === 'string'
												? jsonParse(response.body, {
														fallbackValue:
															response.body,
													})
												: response.body,
										headers: response.headers,
										statusCode: response.statusCode,
										statusMessage:
											response.statusMessage,
									},
									pairedItem: {
										item: originalItemIndex,
									},
								};
							} else {
								let bodyData = response.body;
								// Handle Buffer responses (from autodetect mode where json=false)
								if (Buffer.isBuffer(bodyData)) {
									const bodyStr = bodyData.toString('utf-8');
									try {
										bodyData = JSON.parse(bodyStr);
									} catch {
										bodyData = bodyStr;
									}
								} else if (typeof bodyData === 'string') {
									try {
										bodyData = JSON.parse(bodyData);
									} catch {}
								}
								if (
									typeof bodyData === 'object' &&
									bodyData !== null
								) {
									if (Object.keys(bodyData).length === 0) {
										returnItems[idx] = {
											json: { item: originalItemIndex },
											pairedItem: {
												item: originalItemIndex,
											},
										};
									} else {
										returnItems[idx] = {
											json: bodyData,
											pairedItem: {
												item: originalItemIndex,
											},
										};
									}
								} else {
									returnItems[idx] = {
										json: { data: bodyData },
										pairedItem: {
											item: originalItemIndex,
										},
									};
								}
							}
						} else if (
							typeof response === 'object' &&
							response !== null
						) {
							if (Object.keys(response).length === 0) {
								returnItems[idx] = {
									json: { item: originalItemIndex },
									pairedItem: { item: originalItemIndex },
								};
							} else {
								returnItems[idx] = {
									json: response,
									pairedItem: { item: originalItemIndex },
								};
							}
						} else {
							try {
								const parsed = JSON.parse(response);
								returnItems[idx] = {
									json: parsed,
									pairedItem: {
										item: originalItemIndex,
									},
								};
							} catch {
								returnItems[idx] = {
									json: { data: response },
									pairedItem: {
										item: originalItemIndex,
									},
								};
							}
						}
					}
					// If still rejected, leave the error item in place
				}
			}
		}

		// === Final Cleanup ===
		// Replace null values with empty strings to avoid serialization issues
		returnItems = returnItems.map(replaceNullValues);

		// === Execution Hint for UI ===
		// Provide helpful message if response contains array data that could be split
		if (
			returnItems.length === 1 &&
			returnItems[0].json.data &&
			Array.isArray(returnItems[0].json.data)
		) {
			const message =
				"To split the contents of 'data' into separate items for easier processing, add a 'Split Out' node after this one";
			if (this.addExecutionHints) {
				this.addExecutionHints({
					message,
					location: 'outputPane',
				});
			} else {
				this.logger.info(message);
			}
		}

		// Return all processed items
		return [returnItems];
	}
}
