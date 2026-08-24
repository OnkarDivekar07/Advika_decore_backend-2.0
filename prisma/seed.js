const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.error('❌ ADMIN_EMAIL or ADMIN_PASSWORD is not defined in .env');
    process.exit(1);
  }

  const existingAdmin = await prisma.user.findFirst({
    where: { email: adminEmail },
  });
  if (existingAdmin) {
    console.log('✅ Admin user already exists. No need to seed.');
    return;
  }

  const hashedPassword = await bcrypt.hash(adminPassword, 10);
  const adminUser = await prisma.user.create({
    data: {
      name: 'Admin User',
      email: adminEmail,
      password: hashedPassword,
      role: 'admin',
      phone: '9657024612',
    },
  });

  console.log('✅ Admin user created:', adminUser.email);
}

// --- Advika Auto storefront catalog -----------------------------------
//
// See design_handoff_advika_auto/README.md — this seed exists so the
// design's "Domain rule: 12V vs 24V" and its Landing/Vehicle/Product
// screens have real data to render against instead of an empty catalog.
// Category labels below match frontend/src/config/advikaAuto.js's
// CATEGORIES exactly (Product.category is a free-text String[] matched
// by label, not an id/relation).
//
// The first 8 `isBestSeller` products (created in this exact order,
// with the flagship Pro-X created *before* them) are the README's
// Landing screen 1 §6 "Best sellers" table verbatim — same names,
// prices, MRPs and discounts — so GET /api/products?isBestSeller=true
// &limit=8&sort=createdAt&order=desc (HomePage.jsx's query) returns
// exactly this set, newest-first, with Pro-X excluded by the limit.

const PROX_100W_SPECS = {
  Wattage: '100W (50×2W LEDs)',
  Lumens: '9,000 lm',
  'Beam Pattern': 'Combo',
  'Color Temp': '6000K Pure White',
  Voltage: '9-32V DC (12V & 24V)',
  'IP Rating': 'IP68',
  Housing: 'Die-cast Aluminium',
  Lens: 'PC 30° Anti-glare',
  Lifespan: '50,000+ hours',
  Size: '22 inch curved',
};

const PROX_100W_VARIANTS = [
  {
    label: 'Wattage',
    defaultIndex: 1,
    options: [
      { label: '72W', price: 9999, mrp: 12999 },
      { label: '100W', price: 12999, mrp: 16999 },
      { label: '150W', price: 16499, mrp: 21999 },
      { label: '200W', price: 21999, mrp: 28999 },
    ],
  },
  {
    label: 'Beam',
    defaultIndex: 2,
    options: [{ label: 'Spot' }, { label: 'Flood' }, { label: 'Combo' }],
  },
];

const HEAVY_24V_COMPAT = {
  '24V': [
    'Tata Signa 2823',
    'Tata Signa 4825',
    'Tata Prima 4928',
    'Ashok Leyland 1616',
    'BharatBenz 1917',
  ],
};

const DUAL_VOLTAGE_COMPAT = {
  ...HEAVY_24V_COMPAT,
  '12V': [
    'Tata Ace',
    'Ashok Leyland Bada Dost',
    'Mahindra Bolero Pik-Up',
    'Tata Intra V30',
    'Maruti Super Carry',
  ],
};

const LIGHT_12V_COMPAT = {
  '12V': [
    'Tata Ace',
    'Tata Ace Gold',
    'Ashok Leyland Bada Dost',
    'Mahindra Bolero Pik-Up',
    'Maruti Super Carry',
  ],
};

const PRODUCTS = [
  // Flagship product-detail SKU — README screen 4 (Product detail) is
  // written around exactly this item: wattage/beam variants with live
  // repricing, dual-voltage fitment groups, and the 10-row spec table.
  {
    name: 'Pro-X 100W LED Light Bar',
    category: ['Lights'],
    brand: 'Advika',
    price: 12999,
    mrp: 16999,
    stock: 42,
    description:
      'A 22-inch curved LED light bar built for Indian highway conditions — die-cast aluminium housing, IP68 sealing, and a 9-32V DC driver that runs on both 12V and 24V commercial vehicles without a converter. Combo beam pattern throws a wide near field and a focused long-range spot in one bar.',
    voltage: '12V/24V',
    specs: PROX_100W_SPECS,
    variants: PROX_100W_VARIANTS,
    compatibility: DUAL_VOLTAGE_COMPAT,
    rating: 4.8,
    reviewCount: 234,
    isBestSeller: false,
    images: [],
  },
  // --- The 8 Landing "Best sellers" (README lines 110-121) -----------
  {
    name: '48" Curved LED Light Bar',
    category: ['Lights'],
    brand: 'Advika',
    price: 8499,
    mrp: 11999,
    stock: 30,
    description:
      'A 48-inch curved light bar for big trucks and trailers that need wide, even coverage across the front. Dual-voltage driver — one SKU fits a Signa and an Ace alike.',
    voltage: '12V/24V',
    specs: {
      Wattage: '180W',
      Lumens: '16,200 lm',
      'Beam Pattern': 'Combo',
      Voltage: '9-32V DC (12V & 24V)',
      'IP Rating': 'IP68',
    },
    compatibility: DUAL_VOLTAGE_COMPAT,
    rating: 4.7,
    reviewCount: 189,
    isBestSeller: true,
    images: [],
  },
  {
    name: 'Chrome Air Horn Set, 4 Pipe',
    category: ['Horns & Air'],
    brand: 'Advika',
    price: 2499,
    mrp: 3499,
    stock: 25,
    description:
      'A 4-pipe chrome air horn set with the deep, layered tone drivers listen for on the highway. 24V compressor-driven system — do not fit on a 12V pickup without a step-up converter.',
    voltage: '24V',
    specs: { Pipes: '4', Voltage: '24V', 'Sound Level': '150 dB' },
    compatibility: HEAVY_24V_COMPAT,
    rating: 4.6,
    reviewCount: 142,
    isBestSeller: true,
    images: [],
  },
  {
    name: 'LED Strip Light Kit 5M',
    category: ['Lights'],
    brand: 'Advika',
    price: 1299,
    mrp: 1799,
    stock: 60,
    description:
      'A 5-metre flexible LED strip kit for cabin and chassis trim lighting, cut-to-length every 3 LEDs.',
    voltage: '12V',
    specs: { Length: '5M', Voltage: '12V', 'IP Rating': 'IP65' },
    compatibility: LIGHT_12V_COMPAT,
    rating: 4.5,
    reviewCount: 98,
    isBestSeller: true,
    images: [],
  },
  {
    name: 'Cushioned Seat Cover Set',
    category: ['Interior & Comfort'],
    brand: 'Advika',
    price: 1899,
    mrp: 2699,
    stock: 40,
    description:
      'A cushioned, breathable seat cover set sized for long-haul driver seats — no voltage, no fitment restriction, fits any cab.',
    rating: 4.4,
    reviewCount: 76,
    isBestSeller: true,
    images: [],
  },
  {
    name: 'LED Fog Light Pair',
    category: ['Lights'],
    brand: 'Advika',
    price: 2499,
    mrp: 3499,
    stock: 35,
    description:
      'A pair of amber LED fog lights for cutting through monsoon haze, 24V system for medium and big commercial vehicles.',
    voltage: '24V',
    specs: {
      Wattage: '48W (pair)',
      'Beam Pattern': 'Flood',
      Voltage: '24V',
      'IP Rating': 'IP67',
    },
    compatibility: HEAVY_24V_COMPAT,
    rating: 4.6,
    reviewCount: 121,
    isBestSeller: true,
    images: [],
  },
  {
    name: 'Heavy Duty Mud Flap Set',
    category: ['Exterior Styling'],
    brand: 'Advika',
    price: 899,
    mrp: 1299,
    stock: 50,
    description:
      'A set of reinforced rubber mud flaps that hold shape at highway speed — no electrical fitment, fits any vehicle size.',
    rating: 4.3,
    reviewCount: 54,
    isBestSeller: true,
    images: [],
  },
  {
    name: '24V Charger + USB Hub',
    category: ['Electrical & Wiring'],
    brand: 'Advika',
    price: 749,
    mrp: 999,
    stock: 70,
    description:
      'A dash-mount 24V charger with dual USB-A ports for phone and GPS charging on medium and big trucks. Not for 12V pickups.',
    voltage: '24V',
    specs: { Input: '24V DC', Output: '2× USB-A, 3.1A total' },
    compatibility: HEAVY_24V_COMPAT,
    rating: 4.2,
    reviewCount: 41,
    isBestSeller: true,
    images: [],
  },
  {
    name: 'Steering Cover + Knob Combo',
    category: ['Interior & Comfort'],
    brand: 'Advika',
    price: 649,
    mrp: 899,
    stock: 80,
    description:
      'A grippy steering wheel cover paired with a spinner knob for tight-turn manoeuvring — no voltage, fits any cab.',
    rating: 4.1,
    reviewCount: 33,
    isBestSeller: true,
    images: [],
  },
  // --- Extra catalog depth: more voltage variety, low/out-of-stock -----
  {
    name: 'FogMaster Dual Beam Set',
    category: ['Lights'],
    brand: 'Advika',
    price: 7299,
    mrp: 8999,
    stock: 20,
    description:
      'A dual-beam fog light set combining spot and flood patterns, dual-voltage driver.',
    voltage: '12V/24V',
    specs: {
      Wattage: '48W',
      'Beam Pattern': 'Dual (Spot + Flood)',
      Voltage: '9-32V DC (12V & 24V)',
    },
    compatibility: DUAL_VOLTAGE_COMPAT,
    rating: 4.5,
    reviewCount: 87,
    isBestSeller: false,
    images: [],
  },
  {
    name: 'SlimBar 72W LED Light Bar',
    category: ['Lights'],
    brand: 'Advika',
    price: 9999,
    mrp: 12999,
    stock: 3,
    description:
      'A slim-profile 72W light bar for grille-mount installs where clearance is tight.',
    voltage: '12V/24V',
    specs: {
      Wattage: '72W',
      'Beam Pattern': 'Combo',
      Voltage: '9-32V DC (12V & 24V)',
    },
    compatibility: DUAL_VOLTAGE_COMPAT,
    rating: 4.6,
    reviewCount: 58,
    isBestSeller: false,
    images: [],
  },
  {
    name: 'Cotton Dash Mat, Large',
    category: ['Interior & Comfort'],
    brand: 'Advika',
    price: 549,
    mrp: 799,
    stock: 0,
    description:
      'A large cotton dash mat that cuts glare off the windshield on long day runs.',
    rating: 4.0,
    reviewCount: 19,
    isBestSeller: false,
    images: [],
  },
  {
    name: '12V Reverse Horn with Sensor',
    category: ['Horns & Air'],
    brand: 'Advika',
    price: 1099,
    mrp: 1499,
    stock: 45,
    description:
      'A 12V reverse horn with built-in proximity sensor for small commercial vehicles and pickups.',
    voltage: '12V',
    specs: { Voltage: '12V', 'Sound Level': '112 dB' },
    compatibility: LIGHT_12V_COMPAT,
    rating: 4.3,
    reviewCount: 47,
    isBestSeller: false,
    images: [],
  },
  {
    name: 'Braided Wiring Harness Kit',
    category: ['Electrical & Wiring'],
    brand: 'Advika',
    price: 1899,
    mrp: 2499,
    stock: 22,
    description:
      'A braided, heat-resistant wiring harness kit for a clean auxiliary-light install, dual-voltage rated.',
    voltage: '12V/24V',
    specs: { Voltage: '9-32V DC (12V & 24V)', Length: '5M' },
    rating: 4.2,
    reviewCount: 28,
    isBestSeller: false,
    images: [],
  },
  {
    name: 'Reflective Safety Triangle Kit',
    category: ['Safety & Tools'],
    brand: 'Advika',
    price: 399,
    mrp: 599,
    stock: 90,
    description:
      'A pair of foldable reflective warning triangles for breakdown safety on the highway.',
    rating: 4.4,
    reviewCount: 64,
    isBestSeller: false,
    images: [],
  },
  {
    name: 'Universal Mounting Bracket Set',
    category: ['Spares & Fitting'],
    brand: 'Advika',
    price: 449,
    mrp: 599,
    stock: 55,
    description:
      'A universal steel bracket set for mounting light bars and fog lights across bumper profiles.',
    rating: 4.1,
    reviewCount: 22,
    isBestSeller: false,
    images: [],
  },
];

async function seedProducts() {
  let created = 0;
  for (const product of PRODUCTS) {
    const existing = await prisma.product.findFirst({
      where: { name: product.name },
    });
    if (existing) continue;
    await prisma.product.create({ data: product });
    created += 1;
  }
  console.log(
    created > 0
      ? `✅ Seeded ${created} Advika Auto product(s).`
      : '✅ Product catalog already seeded. No need to seed.'
  );
}

async function main() {
  await seedAdmin();
  await seedProducts();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
