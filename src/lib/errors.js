export class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message = '請先登入') => new HttpError(401, message);
export const forbidden = (message = '權限不足') => new HttpError(403, message);
export const notFound = (message = '找不到資料') => new HttpError(404, message);
export const conflict = (message, details) => new HttpError(409, message, details);
