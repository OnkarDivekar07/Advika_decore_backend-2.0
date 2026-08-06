/**
 * @swagger
 * tags:
 *   name: User
 *   description: Endpoints for managing user's delivery addresses
 */

/**
 * @swagger
 * /api/user/address:
 *   post:
 *     summary: Create a new delivery address
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAddressInput'
 *     responses:
 *       201:
 *         description: Address created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AddressResponse'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *
 * components:
 *   schemas:
 *     CreateAddressInput:
 *       type: object
 *       required:
 *         - name
 *         - phone
 *         - pincode
 *         - city
 *         - state
 *         - houseArea
 *       properties:
 *         name:
 *           type: string
 *           minLength: 2
 *           example: "Rahul Sharma"
 *           description: Name of the user. Minimum 2 characters.
 *         phone:
 *           type: string
 *           example: "9876543210"
 *           description: Valid Indian mobile number.
 *         pincode:
 *           type: string
 *           example: "411001"
 *           description: Valid Indian postal code (PIN code).
 *         city:
 *           type: string
 *           example: "Pune"
 *         state:
 *           type: string
 *           example: "Maharashtra"
 *         houseArea:
 *           type: string
 *           example: "Flat No. 101, Lotus Apartments"
 *         landmark:
 *           type: string
 *           minLength: 2
 *           example: "Near Big Bazaar"
 *           description: Optional field. Minimum 2 characters if provided.
 *
 *     AddressResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         message:
 *           type: string
 *           example: "Address created successfully"
 *         data:
 *           type: object
 *           properties:
 *             id:
 *               type: string
 *               example: "64b7b93a3f2c8b2a0fcef1a1"
 *             userId:
 *               type: string
 *               example: "64b7b83e3f2c8b2a0fcef199"
 *             name:
 *               type: string
 *               example: "Rahul Sharma"
 *             phone:
 *               type: string
 *               example: "9876543210"
 *             pincode:
 *               type: string
 *               example: "411001"
 *             city:
 *               type: string
 *               example: "Pune"
 *             state:
 *               type: string
 *               example: "Maharashtra"
 *             houseArea:
 *               type: string
 *               example: "Flat No. 101, Lotus Apartments"
 *             landmark:
 *               type: string
 *               example: "Near Big Bazaar"
 *             createdAt:
 *               type: string
 *               format: date-time
 *               example: "2025-07-04T07:22:33.123Z"
 *             updatedAt:
 *               type: string
 *               format: date-time
 *               example: "2025-07-04T07:22:33.123Z"
 */

/**
 * @swagger
 * /api/user/addresses:
 *   get:
 *     summary: Get all delivery addresses for the logged-in user
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of addresses
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/AddressResponse'
 *       401:
 *         description: Unauthorized
 */

/**
 * @swagger
 * /api/user/address/{id}:
 *   put:
 *     summary: Update a delivery address by ID
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the address to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAddressInput'
 *     responses:
 *       200:
 *         description: Address updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AddressResponse'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (not your address)
 *       404:
 *         description: Address not found
 */

/**
 * @swagger
 * /api/user/address/{id}:
 *   delete:
 *     summary: Delete a delivery address by ID
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the address to delete
 *     responses:
 *       200:
 *         description: Address deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (not your address)
 *       404:
 *         description: Address not found
 */


/**
 * @swagger
 * /api/user/profile:
 *   get:
 *     summary: Get user profile
 *     description: Fetches the profile details of the logged-in user.
 *     tags:
 *       - User
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: User profile fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "ckvu2i3lt0001n3l59qodt9r7"
 *                     name:
 *                       type: string
 *                       example: "Onkar"
 *                     email:
 *                       type: string
 *                       example: "onkar@example.com"
 *                     address:
 *                       type: string
 *                       example: "123 Main St, Pune, India"
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-07-07T06:00:00.000Z"
 *       401:
 *         description: Unauthorized - Token missing or invalid
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
