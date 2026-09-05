// tests/unit/imageQueue.test.js
//
// Pattern 15 (R2/S3 migration audit) — "image worker retries/failure
// state": locks in the actual retry contract create-product/update-product
// jobs run under, since nothing previously asserted on it directly (only
// imageWorker.js's own header comment documented the intent). This also
// backs the reasoning behind admin_panel_fixed's src/api/productJobs.js
// poll ceiling — see that file's comment on why it has to comfortably
// exceed the cumulative backoff computed here (10s + 20s = 30s minimum
// before a job can reach 'failed', even before any attempt's own
// execution time).
const mockQueueCtor = jest.fn();
jest.mock('bullmq', () => ({
  Queue: mockQueueCtor,
}));
jest.mock('@config/redis', () => ({}));

describe('imageQueue', () => {
  it('retries a failing create/update job 3 times with exponential backoff', () => {
    // eslint-disable-next-line global-require
    require('../../src/jobs/queues/imageQueue');

    expect(mockQueueCtor).toHaveBeenCalledWith(
      'image-processing-queue',
      expect.objectContaining({
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
        },
      })
    );
  });
});
