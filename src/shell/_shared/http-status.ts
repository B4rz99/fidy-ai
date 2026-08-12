/** The response status carried by a successful read. */
export const okStatus = 200;

/** The response status a canonical operation declares when it creates a record. */
export const createdStatus = 201;

/** The response status for durable work accepted for asynchronous processing. */
export const acceptedStatus = 202;

/** The status a caller receives when it presented no usable credential. */
export const unauthorizedStatus = 401;

/** The status a caller receives when its credential does not reach the resource. */
export const forbiddenStatus = 403;

/** The status a server returns when it gave up waiting for the request. */
export const requestTimeoutStatus = 408;

/** The status a server returns when the caller exceeded a rate limit. */
export const tooManyRequestsStatus = 429;

/** Lowest status in the range that blames the server rather than the caller. */
export const firstServerErrorStatus = 500;

/** Highest status in the range that blames the server rather than the caller. */
export const lastServerErrorStatus = 599;
