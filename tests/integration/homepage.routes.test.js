const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// Explicit factory (not automock) — the real homepage.service.js pulls in
// paginateWithCache -> @config/redis, which would open a real Redis
// connection attempt just to introspect the module's shape.
jest.mock('@modules/homepage/homepage.service', () => ({
  getLatestBanner: jest.fn(),
  createNewBanner: jest.fn(),
  deleteBannerById: jest.fn(),
  getBannerById: jest.fn(),
  softDeleteNewArrivalService: jest.fn(),
  getNewArrivalProducts: jest.fn(),
}));
jest.mock('../../src/services/external/AWSUploads');

const homepageService = require('@modules/homepage/homepage.service');
const awsService = require('../../src/services/external/AWSUploads');
const homepageRoutes = require('@modules/homepage/homepage.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/homepage', homepageRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

const adminToken = jwt.sign(
  { userId: 'admin1', role: 'admin' },
  process.env.JWT_SECRET
);
const customerToken = jwt.sign(
  { userId: 'user1', role: 'customer' },
  process.env.JWT_SECRET
);

describe('GET /api/homepage/banners (public)', () => {
  it('lists banners with no auth required', async () => {
    homepageService.getLatestBanner.mockResolvedValue({
      data: [{ id: 'b1' }],
      meta: { total: 1 },
    });

    const res = await request(app).get('/api/homepage/banners');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'b1' }]);
  });
});

describe('GET /api/homepage/new-arrivals (public)', () => {
  it('422s an out-of-range limit', async () => {
    const res = await request(app).get(
      '/api/homepage/new-arrivals?limit=500'
    );
    expect(res.status).toBe(422);
    expect(homepageService.getNewArrivalProducts).not.toHaveBeenCalled();
  });

  it('lists new arrivals for a valid query, no auth required', async () => {
    homepageService.getNewArrivalProducts.mockResolvedValue({
      data: [{ id: 'p1' }],
      meta: { total: 1 },
    });

    const res = await request(app).get(
      '/api/homepage/new-arrivals?page=1&limit=10'
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'p1' }]);
  });
});

describe('POST /api/homepage/banners (admin only)', () => {
  it('401s with no token', async () => {
    const res = await request(app).post('/api/homepage/banners');
    expect(res.status).toBe(401);
  });

  it('403s a non-admin token', async () => {
    const res = await request(app)
      .post('/api/homepage/banners')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it('422s an invalid linkUrl for an admin token', async () => {
    const res = await request(app)
      .post('/api/homepage/banners')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('linkUrl', 'not-a-url')
      .attach('image', Buffer.from('fake-image-bytes'), 'banner.jpg');

    expect(res.status).toBe(422);
    expect(homepageService.createNewBanner).not.toHaveBeenCalled();
  });

  it('400s when no image file is attached, even with a valid admin token', async () => {
    const res = await request(app)
      .post('/api/homepage/banners')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('linkUrl', 'https://advika.com/sale');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('No image file uploaded');
    expect(awsService.uploadToS3).not.toHaveBeenCalled();
  });

  it('uploads the image and creates the banner for a valid admin request', async () => {
    awsService.uploadToS3.mockResolvedValue(
      'https://bucket.s3.ap-south-1.amazonaws.com/banner-images/1_banner.jpg'
    );
    homepageService.createNewBanner.mockResolvedValue({
      id: 'banner_1',
      imageUrl: 'https://bucket.s3.ap-south-1.amazonaws.com/banner-images/1_banner.jpg',
    });

    const res = await request(app)
      .post('/api/homepage/banners')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('linkUrl', 'https://advika.com/sale')
      .attach('image', Buffer.from('fake-image-bytes'), 'banner.jpg');

    expect(res.status).toBe(201);
    expect(awsService.uploadToS3).toHaveBeenCalledTimes(1);
    expect(homepageService.createNewBanner).toHaveBeenCalledWith(
      'https://bucket.s3.ap-south-1.amazonaws.com/banner-images/1_banner.jpg',
      'https://advika.com/sale'
    );
    expect(res.body.data.id).toBe('banner_1');
  });
});

describe('DELETE /api/homepage/banners/:id (admin only)', () => {
  it('401s with no token', async () => {
    const res = await request(app).delete('/api/homepage/banners/b1');
    expect(res.status).toBe(401);
  });

  it('404s a banner that does not exist and never touches S3', async () => {
    homepageService.getBannerById.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/homepage/banners/missing')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(awsService.deleteFromS3).not.toHaveBeenCalled();
  });

  it('deletes the S3 object and the DB row for an existing banner', async () => {
    homepageService.getBannerById.mockResolvedValue({
      id: 'b1',
      imageUrl: 'https://bucket.s3.ap-south-1.amazonaws.com/banner-images/foo.jpg',
    });
    homepageService.deleteBannerById.mockResolvedValue({ id: 'b1' });

    const res = await request(app)
      .delete('/api/homepage/banners/b1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(awsService.deleteFromS3).toHaveBeenCalledWith(
      'banner-images/foo.jpg'
    );
    expect(homepageService.deleteBannerById).toHaveBeenCalledWith('b1');
  });
});

describe('PATCH /api/homepage/new-arrivals/:id (admin only)', () => {
  it('403s a non-admin token', async () => {
    const res = await request(app)
      .patch('/api/homepage/new-arrivals/p1')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it('soft-deletes the new-arrival flag for a valid admin request', async () => {
    homepageService.softDeleteNewArrivalService.mockResolvedValue({
      id: 'p1',
      isNewArrival: false,
    });

    const res = await request(app)
      .patch('/api/homepage/new-arrivals/p1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(homepageService.softDeleteNewArrivalService).toHaveBeenCalledWith(
      'p1'
    );
  });
});
