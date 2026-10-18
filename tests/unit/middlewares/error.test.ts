import mongoose from 'mongoose';
import httpMocks from 'node-mocks-http';
import { TokenExpiredError } from 'jsonwebtoken';
import { errorConverter, errorHandler } from '../../../src/middlewares/error';
import { AppError } from '../../../src/core/errors';
import config from '../../../src/config/config';
import logger from '../../../src/config/logger';

const run = (error: unknown) => {
  const next = jest.fn();
  errorConverter(error, httpMocks.createRequest(), httpMocks.createResponse(), next);
  return next.mock.calls[0][0] as AppError;
};

describe('Error middlewares', () => {
  describe('Error converter', () => {
    test('should pass an AppError through untouched', () => {
      const error = new AppError('RX_LOCKED', 'Already approved');
      expect(run(error)).toBe(error);
    });

    test('should convert a mongoose CastError to a 400 VALIDATION_ERROR', () => {
      const error = new mongoose.Error.CastError('ObjectId', 'nope', 'patientId');
      const converted = run(error);
      expect(converted.code).toBe('VALIDATION_ERROR');
      expect(converted.statusCode).toBe(400);
    });

    test('should convert a mongoose ValidationError to a 400 with a field list', () => {
      const error = new mongoose.Error.ValidationError();
      error.addError('name', new mongoose.Error.ValidatorError({ path: 'name', message: 'name is required' }));
      const converted = run(error);
      expect(converted.code).toBe('VALIDATION_ERROR');
      expect(converted.details).toEqual([{ field: 'name', message: 'name is required' }]);
    });

    test('should convert a duplicate key error to a 409 CONFLICT', () => {
      const converted = run(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      expect(converted.code).toBe('CONFLICT');
      expect(converted.statusCode).toBe(409);
    });

    test('should convert an expired token to TOKEN_EXPIRED, which the app refreshes on', () => {
      const converted = run(new TokenExpiredError('jwt expired', new Date()));
      expect(converted.code).toBe('TOKEN_EXPIRED');
      expect(converted.statusCode).toBe(401);
    });

    test('should convert anything else to a non-operational INTERNAL', () => {
      const converted = run(new Error('Any error'));
      expect(converted.code).toBe('INTERNAL');
      expect(converted.statusCode).toBe(500);
      expect(converted.isOperational).toBe(false);
    });

    test('should convert a thrown non-error to a non-operational INTERNAL', () => {
      const converted = run({});
      expect(converted.code).toBe('INTERNAL');
      expect(converted.isOperational).toBe(false);
    });
  });

  describe('Error handler', () => {
    beforeEach(() => {
      jest.spyOn(logger, 'error').mockImplementation(() => logger);
      jest.spyOn(logger, 'debug').mockImplementation(() => logger);
    });

    test('should answer with the { error: { code, message } } envelope', () => {
      const error = new AppError('NOT_MEMBER', 'You are not a member of this practice');
      const res = httpMocks.createResponse();
      const sendSpy = jest.spyOn(res, 'send');

      errorHandler(error, httpMocks.createRequest(), res, jest.fn());

      expect(res.statusCode).toBe(403);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'NOT_MEMBER', message: error.message }),
        }),
      );
      expect(res.locals.errorMessage).toBe(error.message);
    });

    test('should include details when the error carries them', () => {
      const details = [{ field: 'body.phone', message: 'must be a phone number in E.164 format' }];
      const error = new AppError('VALIDATION_ERROR', 'invalid', details);
      const res = httpMocks.createResponse();
      const sendSpy = jest.spyOn(res, 'send');

      errorHandler(error, httpMocks.createRequest(), res, jest.fn());

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details }) }));
    });

    test('should put the stack in the response in development', () => {
      config.env = 'development';
      const error = new AppError('NOT_FOUND', 'Any error');
      const res = httpMocks.createResponse();
      const sendSpy = jest.spyOn(res, 'send');

      errorHandler(error, httpMocks.createRequest(), res, jest.fn());

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ stack: error.stack }) }),
      );
      config.env = 'test';
    });

    test('should hide a bug behind a flat 500 in production', () => {
      config.env = 'production';
      config.isProduction = true;
      const error = new AppError('VALIDATION_ERROR', 'the mongo connection string is wrong', undefined, false);
      const res = httpMocks.createResponse();
      const sendSpy = jest.spyOn(res, 'send');

      errorHandler(error, httpMocks.createRequest(), res, jest.fn());

      expect(res.statusCode).toBe(500);
      expect(sendSpy).toHaveBeenCalledWith({
        error: { code: 'INTERNAL', message: 'Something went wrong' },
      });
      // The real message is still logged, against the request id.
      expect(res.locals.errorMessage).toBe('the mongo connection string is wrong');
      config.env = 'test';
      config.isProduction = false;
    });

    test('should keep an expected error intact in production', () => {
      config.env = 'production';
      config.isProduction = true;
      const error = new AppError('RX_LOCKED', 'An approved prescription cannot be edited');
      const res = httpMocks.createResponse();
      const sendSpy = jest.spyOn(res, 'send');

      errorHandler(error, httpMocks.createRequest(), res, jest.fn());

      expect(res.statusCode).toBe(409);
      expect(sendSpy).toHaveBeenCalledWith({ error: { code: 'RX_LOCKED', message: error.message } });
      config.env = 'test';
      config.isProduction = false;
    });
  });
});
