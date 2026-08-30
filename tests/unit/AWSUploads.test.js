// tests/unit/AWSUploads.test.js
//
// Covers the S3->R2 migration in src/services/external/AWSUploads.js:
// the client now points at Cloudflare R2 (still via @aws-sdk/client-s3,
// R2 is S3-compatible) and public URLs are built from R2_PUBLIC_URL
// instead of the old *.s3.ap-south-1.amazonaws.com pattern. Dummy R2_*
// values come from tests/setup/env.js.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'Put' })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'Delete' })),
}));

const awsService = require('../../src/services/external/AWSUploads');

beforeEach(() => {
  mockSend.mockReset();
});

describe('uploadToS3', () => {
  it('uploads to the configured R2 bucket and returns an R2_PUBLIC_URL-based URL', async () => {
    mockSend.mockResolvedValue({});

    const url = await awsService.uploadToS3(Buffer.from('img'), 'product-images/foo.webp');

    expect(url).toBe('https://media.test.example/product-images/foo.webp');
    const [command] = mockSend.mock.calls[0];
    expect(command.__type).toBe('Put');
    expect(command.input).toMatchObject({
      Bucket: 'dummy-r2-bucket',
      Key: 'product-images/foo.webp',
      ContentType: 'image/webp',
    });
    // R2 doesn't use per-object ACLs the way S3 did.
    expect(command.input).not.toHaveProperty('ACL');
  });

  it('passes through an explicit contentType (banner uploads use the real mimetype)', async () => {
    mockSend.mockResolvedValue({});

    await awsService.uploadToS3(Buffer.from('img'), 'banner-images/bar.jpg', 'image/jpeg');

    expect(mockSend.mock.calls[0][0].input.ContentType).toBe('image/jpeg');
  });

  it('constructs the R2 client with the R2 endpoint and forcePathStyle', async () => {
    // AWSUploads.js lazily caches one client instance for the life of the
    // module, so a fresh module instance (via resetModules) is needed to
    // observe the S3Client constructor call itself, rather than reusing
    // whatever earlier tests in this file already instantiated.
    let freshS3Client;
    let freshAwsService;
    jest.isolateModules(() => {
      jest.doMock('@aws-sdk/client-s3', () => ({
        S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
        PutObjectCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'Put' })),
        DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ input, __type: 'Delete' })),
      }));
      freshS3Client = require('@aws-sdk/client-s3').S3Client;
      freshAwsService = require('../../src/services/external/AWSUploads');
    });
    mockSend.mockResolvedValue({});

    await freshAwsService.uploadToS3(Buffer.from('img'), 'x.webp');

    expect(freshS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'auto',
        endpoint: 'https://dummy-account.r2.cloudflarestorage.com',
        forcePathStyle: true,
        credentials: {
          accessKeyId: 'dummy_r2_access_key',
          secretAccessKey: 'dummy_r2_secret_key',
        },
      })
    );
  });

  it('propagates a failed upload rather than returning a bad URL', async () => {
    mockSend.mockRejectedValue(new Error('network down'));

    await expect(awsService.uploadToS3(Buffer.from('img'), 'x.webp')).rejects.toThrow(
      'network down'
    );
  });
});

describe('deleteFromS3', () => {
  it('deletes the given key from the configured R2 bucket', async () => {
    mockSend.mockResolvedValue({});

    await awsService.deleteFromS3('product-images/foo.webp');

    const [command] = mockSend.mock.calls[0];
    expect(command.__type).toBe('Delete');
    expect(command.input).toEqual({
      Bucket: 'dummy-r2-bucket',
      Key: 'product-images/foo.webp',
    });
  });

  it('propagates a failed delete', async () => {
    mockSend.mockRejectedValue(new Error('not found'));

    await expect(awsService.deleteFromS3('missing.webp')).rejects.toThrow('not found');
  });
});

describe('keyFromPublicUrl', () => {
  it('extracts the key from a URL built from R2_PUBLIC_URL, regardless of TLD', () => {
    // Regression case: this used to be `url.split('.com/')[1]` inline in
    // homepage.controller.js, which silently broke the moment
    // R2_PUBLIC_URL became a non-.com domain (e.g. media.advikaauto.in).
    expect(
      awsService.keyFromPublicUrl('https://media.test.example/banner-images/foo.jpg')
    ).toBe('banner-images/foo.jpg');
  });

  it('still extracts the key from a legacy pre-migration S3 URL', () => {
    expect(
      awsService.keyFromPublicUrl(
        'https://advikaauto.s3.ap-south-1.amazonaws.com/banner-images/foo.jpg'
      )
    ).toBe('banner-images/foo.jpg');
  });

  it('returns null for a URL matching neither format', () => {
    expect(awsService.keyFromPublicUrl('https://unrelated.example/foo.jpg')).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(awsService.keyFromPublicUrl(undefined)).toBeNull();
    expect(awsService.keyFromPublicUrl(null)).toBeNull();
  });
});
