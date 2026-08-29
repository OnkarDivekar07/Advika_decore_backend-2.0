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
// by label, not an id/relation) — retagged onto the real Advika Auto
// decoration-accessory taxonomy (Lights/Steering Cover/Tassels &
// Hangings/etc.); a few functional-parts demo SKUs that didn't fit any
// decoration category (wiring harness, mounting brackets, safety
// triangle, 24V charger) were dropped rather than force-mapped.
//
// The `isBestSeller` products (created in this exact order, with the
// flagship Pro-X created *before* them) are close to the README's
// Landing screen 1 §6 "Best sellers" table (one entry dropped above) —
// GET /api/products?isBestSeller=true&limit=8&sort=createdAt&order=desc
// (HomePage.jsx's query) returns this set, newest-first, with Pro-X
// excluded by the limit.

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
    category: ['Fan, Charger & Horn'],
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
    category: ['Cloth Decoration'],
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
    category: ['Rubber & Matting'],
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
    name: 'Steering Cover + Knob Combo',
    category: ['Steering Cover'],
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
    category: ['Rubber & Matting'],
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
    category: ['Fan, Charger & Horn'],
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

// --- Admin-editable storefront text (SiteContent) ----------------------
//
// Seeded with the EXACT text frontend-improved/src/i18n/{en,hi,mr}.json
// already ship as static strings, so switching the storefront over to
// reading from this table (see HomePage.jsx's ticker) changes nothing
// visible until an admin actually edits a row via the admin panel's
// Content Management page. Idempotent per-key (upsert), same as every
// other admin-editable value here — safe to re-run.
const SITE_CONTENT = [
  {
    key: 'ticker.cod',
    valueEn: 'CASH ON DELIVERY',
    valueHi: 'कैश ऑन डिलीवरी',
    valueMr: 'कॅश ऑन डिलिव्हरी',
  },
  {
    key: 'ticker.shipping',
    valueEn: 'FREE SHIPPING ABOVE ₹999',
    valueHi: '₹999 से ऊपर मुफ़्त शिपिंग',
    valueMr: '₹999 वरील मोफत शिपिंग',
  },
  {
    key: 'ticker.delivery',
    valueEn: 'DELIVERY IN 3-4 DAYS',
    valueHi: '3-4 दिनों में डिलीवरी',
    valueMr: '3-4 दिवसांत डिलिव्हरी',
  },
  // Landing page hero — matches frontend-improved/src/i18n/{en,hi,mr}.json's
  // advika.landing.{eyebrow,headlineLine1-3,subhead} exactly, same
  // "changes nothing until an admin edits it" reasoning as the ticker rows
  // above.
  {
    key: 'hero.eyebrow',
    valueEn: 'TRUCK LIGHTS & ACCESSORIES',
    valueHi: 'गाड़ी की लाइट और एक्सेसरीज़',
    valueMr: 'गाडीचे लाइट आणि ॲक्सेसरीज',
  },
  {
    key: 'hero.headlineLine1',
    valueEn: 'EVERYTHING',
    valueHi: 'आपकी गाड़ी की',
    valueMr: 'तुमच्या गाडीची',
  },
  {
    key: 'hero.headlineLine2',
    valueEn: 'YOUR TRUCK',
    valueHi: 'हर ज़रूरत',
    valueMr: 'प्रत्येक गरज',
  },
  {
    key: 'hero.headlineLine3',
    valueEn: 'NEEDS',
    valueHi: 'एक जगह',
    valueMr: 'एकाच ठिकाणी',
  },
  {
    key: 'hero.subhead',
    valueEn: 'Lights, horns, seat covers, wiring and more — for trucks, pickups, tempos and tractors. Delivered anywhere in India.',
    valueHi: 'लाइट, हॉर्न, सीट कवर, वायरिंग और बहुत कुछ — ट्रक, पिकअप, टेम्पो और ट्रैक्टर के लिए। पूरे भारत में डिलीवरी।',
    valueMr: 'लाइट, हॉर्न, सीट कव्हर, वायरिंग आणि बरेच काही — ट्रक, पिकअप, टेम्पो आणि ट्रॅक्टरसाठी. संपूर्ण भारतात डिलिव्हरी.',
  },
  // "What do you drive?" vehicle picker — matches
  // frontend-improved/src/i18n/{en,hi,mr}.json's
  // advika.landing.vehiclePickerTitle / advika.vehicleClass.{id} /
  // advika.vehicleClass.examples.{id} exactly. `{id}` matches
  // VEHICLE_CLASSES in frontend-improved/src/config/advikaAuto.js
  // (small/medium/big/tractor) — not admin-renameable independently of
  // that list, just its displayed label/example text.
  {
    key: 'vehiclePicker.title',
    valueEn: 'What do you drive?',
    valueHi: 'आपकी गाड़ी कौन सी है?',
    valueMr: 'तुमची गाडी कोणती?',
  },
  {
    key: 'vehicleClass.small.label',
    valueEn: 'Small vehicle',
    valueHi: 'छोटी गाड़ी',
    valueMr: 'लहान गाडी',
  },
  {
    key: 'vehicleClass.small.examples',
    valueEn: 'Pickup · Tata Ace · Mini Truck etc.',
    valueHi: 'पिकअप · टाटा Ace · मिनी ट्रक आदि',
    valueMr: 'पिकअप · टाटा Ace · मिनी ट्रक इ.',
  },
  {
    key: 'vehicleClass.medium.label',
    valueEn: 'Medium vehicle',
    valueHi: 'मध्यम गाड़ी',
    valueMr: 'मध्यम गाडी',
  },
  {
    key: 'vehicleClass.medium.examples',
    valueEn: '6 Tyre · 8 Tyre · Cargo Truck etc.',
    valueHi: '6 टायर · 8 टायर · कार्गो ट्रक आदि',
    valueMr: '6 टायर · 8 टायर · कार्गो ट्रक इ.',
  },
  {
    key: 'vehicleClass.big.label',
    valueEn: 'Big vehicle',
    valueHi: 'बड़ी गाड़ी',
    valueMr: 'मोठी गाडी',
  },
  {
    key: 'vehicleClass.big.examples',
    valueEn: '10/12/14 Tyre · Tipper · Signa · Multi-Axle etc.',
    valueHi: '10/12/14 टायर · टिपर · Signa · मल्टी-एक्सल आदि',
    valueMr: '10/12/14 टायर · टिपर · Signa · मल्टी-एक्सल इ.',
  },
  {
    key: 'vehicleClass.tractor.label',
    valueEn: 'Tractor',
    valueHi: 'ट्रैक्टर',
    valueMr: 'ट्रॅक्टर',
  },
  {
    key: 'vehicleClass.tractor.examples',
    valueEn: 'Tractor · Trolley · Farm use etc.',
    valueHi: 'ट्रैक्टर · ट्रॉली · खेती के काम आदि',
    valueMr: 'ट्रॅक्टर · ट्रॉली · शेतीच्या कामासाठी इ.',
  },
  // "Shop by category" tiles — replaces the old auto-parts taxonomy with
  // the real Advika Auto decoration-accessory categories (see
  // frontend-improved/src/config/advikaAuto.js's CATEGORIES, which this
  // `{id}` matches). `.examples` is a NEW field the old category tiles
  // never had (only the featured "Lights" card did, as `lightsDesc`) —
  // added to the grid tiles here specifically because it was requested,
  // not carried over from a prior static value. `.count` is the same kind
  // of static, approximate marketing text the old tiles already used
  // (never a live product count — see product.service.js, which has no
  // count-by-category endpoint at all), so making it admin-editable
  // changes nothing about what it represents.
  //
  // KNOWN LIMITATION: the 16 demo products seeded above are tagged with
  // the OLD category labels (Lights, Horns & Air, Interior & Comfort, ...)
  // — none of them carry these new category labels yet, so clicking
  // through most of these new tiles will show zero results until the
  // catalog is re-tagged to match. Flagged, not silently worked around.
  {
    key: 'category.lights.label',
    valueEn: 'LIGHTS',
    valueHi: 'लाइट',
    valueMr: 'लाइट',
  },
  {
    key: 'category.lights.examples',
    valueEn: 'Capsule, Coin, Neon, Strip, Police and Focus lights',
    valueHi: 'कैप्सूल, कॉइन, नियॉन, पट्टी, पुलिस और फोकस लाइट',
    valueMr: 'कॅप्सूल, कॉइन, निऑन, पट्टी, पोलीस आणि फोकस लाइट',
  },
  {
    key: 'category.lights.count',
    valueEn: '120+ products',
    valueHi: '120+ प्रोडक्ट',
    valueMr: '120+ प्रॉडक्ट',
  },
  {
    key: 'category.steering-cover.label',
    valueEn: 'Steering Cover',
    valueHi: 'स्टीयरिंग कवर',
    valueMr: 'स्टीयरिंग कव्हर',
  },
  {
    key: 'category.steering-cover.examples',
    valueEn: 'Silk, Leather, Stretchable',
    valueHi: 'रेशम, लेदर, स्ट्रेचेबल',
    valueMr: 'रेशीम, लेदर, स्ट्रेचेबल',
  },
  {
    key: 'category.steering-cover.count',
    valueEn: '45+ products',
    valueHi: '45+ प्रोडक्ट',
    valueMr: '45+ प्रॉडक्ट',
  },
  {
    key: 'category.tassels-hangings.label',
    valueEn: 'Tassels & Hangings',
    valueHi: 'गोंडे और लटकन',
    valueMr: 'गोंडे आणि लटकन',
  },
  {
    key: 'category.tassels-hangings.examples',
    valueEn: 'Tassels, Hangings, Chandelier',
    valueHi: 'गोंडे, लटकन, झूमर',
    valueMr: 'गोंडे, लटकन, झुंबर',
  },
  {
    key: 'category.tassels-hangings.count',
    valueEn: '90+ products',
    valueHi: '90+ प्रोडक्ट',
    valueMr: '90+ प्रॉडक्ट',
  },
  {
    key: 'category.rubber-matting.label',
    valueEn: 'Rubber & Matting',
    valueHi: 'रबर और मैटिंग',
    valueMr: 'रबर आणि मॅटिंग',
  },
  {
    key: 'category.rubber-matting.examples',
    valueEn: '7 Feet, 5 Feet, Grass',
    valueHi: '7 फीट, 5 फीट, ग्रास',
    valueMr: '7 फूट, 5 फूट, ग्रास',
  },
  {
    key: 'category.rubber-matting.count',
    valueEn: '25+ products',
    valueHi: '25+ प्रोडक्ट',
    valueMr: '25+ प्रॉडक्ट',
  },
  {
    key: 'category.garland-vine-flag.label',
    valueEn: 'Garland, Vine & Flag',
    valueHi: 'हार, बेल और झंडा',
    valueMr: 'हार, वेल आणि झेंडा',
  },
  {
    key: 'category.garland-vine-flag.examples',
    valueEn: 'Cotton, Vine, Saffron Flags',
    valueHi: 'कॉटन, बेल, भगवा झंडे',
    valueMr: 'कॉटन, वेल, भगवे झेंडे',
  },
  {
    key: 'category.garland-vine-flag.count',
    valueEn: '55+ products',
    valueHi: '55+ प्रोडक्ट',
    valueMr: '55+ प्रॉडक्ट',
  },
  {
    key: 'category.cloth-decoration.label',
    valueEn: 'Cloth Decoration',
    valueHi: 'कपड़े की सजावट',
    valueMr: 'कापडी सजावट',
  },
  {
    key: 'category.cloth-decoration.examples',
    valueEn: 'Jhool, Jhalar, Curtain, Chindi',
    valueHi: 'झूल, झालर, पर्दा, चिंदी',
    valueMr: 'झूल, झालर, पडदा, चिंधी',
  },
  {
    key: 'category.cloth-decoration.count',
    valueEn: '60+ products',
    valueHi: '60+ प्रोडक्ट',
    valueMr: '60+ प्रॉडक्ट',
  },
  {
    key: 'category.fan-charger-horn.label',
    valueEn: 'Fan, Charger & Horn',
    valueHi: 'फैन, चार्जर और हॉर्न',
    valueMr: 'फॅन, चार्जर आणि हॉर्न',
  },
  {
    key: 'category.fan-charger-horn.examples',
    valueEn: 'Cobra, Super, Bajrang',
    valueHi: 'कोबरा, सुपर, बजरंग',
    valueMr: 'कोबरा, सुपर, बजरंग',
  },
  {
    key: 'category.fan-charger-horn.count',
    valueEn: '25+ products',
    valueHi: '25+ प्रोडक्ट',
    valueMr: '25+ प्रॉडक्ट',
  },
  {
    key: 'category.useful-items.label',
    valueEn: 'Useful Items',
    valueHi: 'उपयोगी सामान',
    valueMr: 'उपयोगी सामान',
  },
  {
    key: 'category.useful-items.examples',
    valueEn: 'Reflector, Air Pipe',
    valueHi: 'रिफ्लेक्टर, एयर पाइप',
    valueMr: 'रिफ्लेक्टर, एअर पाइप',
  },
  {
    key: 'category.useful-items.count',
    valueEn: '40+ products',
    valueHi: '40+ प्रोडक्ट',
    valueMr: '40+ प्रॉडक्ट',
  },
  {
    key: 'category.mirror-wheelcap.label',
    valueEn: 'Mirror & Wheel Cap',
    valueHi: 'मिरर और व्हील कैप',
    valueMr: 'मिरर आणि व्हीलकॅप',
  },
  {
    key: 'category.mirror-wheelcap.examples',
    valueEn: 'Blind Spot, SS Wheel Cap',
    valueHi: 'ब्लाइंड स्पॉट, SS व्हील कैप',
    valueMr: 'ब्लाइंड स्पॉट, SS व्हीलकॅप',
  },
  {
    key: 'category.mirror-wheelcap.count',
    valueEn: '35+ products',
    valueHi: '35+ प्रोडक्ट',
    valueMr: '35+ प्रॉडक्ट',
  },

  // --- WhatsApp fitment strip, trust grid, and "Driver reviews" ---------
  // Same admin-editable-with-static-fallback pattern as everything above.
  // See HomePage.jsx's WhatsAppStrip/TRUST_ITEMS/SAMPLE_REVIEWS usage.
  {
    key: 'whatsapp.title',
    valueEn: 'Not sure what fits your truck?',
    valueHi: 'पक्का नहीं कि आपके ट्रक में क्या फिट होगा?',
    valueMr: 'तुमच्या ट्रकमध्ये काय बसेल याची खात्री नाही?',
  },
  {
    key: 'whatsapp.subtitle',
    valueEn: 'Send your vehicle model on WhatsApp — reply in 10 minutes',
    valueHi: 'अपनी गाड़ी का मॉडल WhatsApp पर भेजें — 10 मिनट में जवाब',
    valueMr: 'तुमच्या गाडीचे मॉडेल WhatsApp वर पाठवा — 10 मिनिटांत उत्तर',
  },
  {
    key: 'whatsapp.cta',
    valueEn: 'CHAT',
    valueHi: 'चैट करें',
    valueMr: 'चॅट करा',
  },
  {
    key: 'trust.cod.title',
    valueEn: 'Cash on delivery',
    valueHi: 'कैश ऑन डिलीवरी',
    valueMr: 'कॅश ऑन डिलिव्हरी',
  },
  {
    key: 'trust.cod.body',
    valueEn: 'Pay when it reaches you',
    valueHi: 'पहुंचने पर भुगतान करें',
    valueMr: 'पोहोचल्यावर पैसे द्या',
  },
  {
    key: 'trust.shipping.title',
    valueEn: 'Fast shipping',
    valueHi: 'तेज़ शिपिंग',
    valueMr: 'जलद शिपिंग',
  },
  {
    key: 'trust.shipping.body',
    valueEn: 'Delivered in 3-4 days',
    valueHi: '3-4 दिनों में डिलीवरी',
    valueMr: '3-4 दिवसांत डिलिव्हरी',
  },
  {
    key: 'trust.genuine.title',
    valueEn: 'Genuine parts, GST bill',
    valueHi: 'असली पार्ट्स, GST बिल',
    valueMr: 'अस्सल पार्ट्स, GST बिल',
  },
  {
    key: 'trust.genuine.body',
    valueEn: 'Original brands, proper invoice',
    valueHi: 'असली ब्रांड, सही इनवॉइस',
    valueMr: 'अस्सल ब्रँड, योग्य इनव्हॉइस',
  },
  {
    key: 'trust.help.title',
    valueEn: 'Hindi & Marathi help',
    valueHi: 'हिंदी और मराठी सहायता',
    valueMr: 'हिंदी आणि मराठी मदत',
  },
  {
    key: 'trust.help.body',
    valueEn: 'Fitting support on call',
    valueHi: 'कॉल पर फिटिंग सहायता',
    valueMr: 'कॉलवर फिटिंग मदत',
  },
  {
    key: 'reviews.title',
    valueEn: 'Driver reviews',
    valueHi: 'ड्राइवर रिव्यू',
    valueMr: 'ड्रायव्हर रिव्ह्यू',
  },
  {
    key: 'reviews.score',
    valueEn: '4.9',
    valueHi: '4.9',
    valueMr: '4.9',
  },
  {
    key: 'reviews.ratingCount',
    valueEn: '12,400 ratings',
    valueHi: '12,400 रेटिंग्स',
    valueMr: '12,400 रेटिंग्स',
  },
  {
    key: 'reviews.1.name',
    valueEn: 'Ramesh Patil',
    valueHi: 'Ramesh Patil',
    valueMr: 'Ramesh Patil',
  },
  {
    key: 'reviews.1.meta',
    valueEn: 'Tata Signa 4825 · Pune',
    valueHi: 'Tata Signa 4825 · Pune',
    valueMr: 'Tata Signa 4825 · Pune',
  },
  {
    key: 'reviews.1.rating',
    valueEn: '5',
    valueHi: '5',
    valueMr: '5',
  },
  {
    key: 'reviews.1.text',
    valueEn: 'Lights are bright and the fitting was easy. COD made it simple to trust a new shop.',
    valueHi: 'लाइट्स बहुत तेज़ हैं और फिटिंग आसान थी। कैश ऑन डिलीवरी की वजह से नई दुकान पर भरोसा करना आसान हो गया।',
    valueMr: 'लाइट्स खूप तेजस्वी आहेत आणि फिटिंग सोपे होते. कॅश ऑन डिलिव्हरीमुळे नवीन दुकानावर विश्वास ठेवणे सोपे झाले.',
  },
  {
    key: 'reviews.2.name',
    valueEn: 'Suresh Yadav',
    valueHi: 'Suresh Yadav',
    valueMr: 'Suresh Yadav',
  },
  {
    key: 'reviews.2.meta',
    valueEn: 'Ashok Leyland 1616 · Nashik',
    valueHi: 'Ashok Leyland 1616 · Nashik',
    valueMr: 'Ashok Leyland 1616 · Nashik',
  },
  {
    key: 'reviews.2.rating',
    valueEn: '5',
    valueHi: '5',
    valueMr: '5',
  },
  {
    key: 'reviews.2.text',
    valueEn: 'Genuine parts with proper GST bill. Delivery took 3 days as promised.',
    valueHi: 'असली पार्ट्स सही GST बिल के साथ मिले। डिलीवरी वादे के मुताबिक 3 दिन में हो गई।',
    valueMr: 'योग्य GST बिलासह अस्सल पार्ट्स मिळाले. सांगितल्याप्रमाणे डिलिव्हरी 3 दिवसांत झाली.',
  },
  {
    key: 'reviews.3.name',
    valueEn: 'Vikas Chauhan',
    valueHi: 'Vikas Chauhan',
    valueMr: 'Vikas Chauhan',
  },
  {
    key: 'reviews.3.meta',
    valueEn: 'Mahindra Bolero Pik-Up · Nagpur',
    valueHi: 'Mahindra Bolero Pik-Up · Nagpur',
    valueMr: 'Mahindra Bolero Pik-Up · Nagpur',
  },
  {
    key: 'reviews.3.rating',
    valueEn: '4',
    valueHi: '4',
    valueMr: '4',
  },
  {
    key: 'reviews.3.text',
    valueEn: 'Good quality horn set. Support answered in Hindi over call, very helpful.',
    valueHi: 'अच्छी क्वालिटी का हॉर्न सेट। सपोर्ट टीम ने कॉल पर हिंदी में जवाब दिया, बहुत मददगार।',
    valueMr: 'चांगल्या दर्जाचा हॉर्न सेट. सपोर्टने कॉलवर हिंदीत उत्तर दिले, खूप उपयुक्त.',
  },

  // --- Footer: brand blurb, business phone, hours, address --------------
  // `brand.phone` is a single site-wide value (not per-language — a phone
  // number doesn't translate) read by useBrandPhone.js, which derives the
  // actual tel:/wa.me link targets from it too, so editing this one row
  // keeps every click-to-call/WhatsApp link across the app (footer,
  // sticky bar, product detail, cart, order tracking, vehicle page, slide
  // menu) in sync — see HomePage.jsx's earlier WhatsApp-strip section for
  // the same "one source of truth" reasoning applied to text content.
  {
    key: 'footer.blurb',
    valueEn: 'Decorative lights and accessories for trucks, pickups, tempos and tractors.',
    valueHi: 'ट्रक, पिकअप, टेम्पो और ट्रैक्टर के लिए सजावटी लाइट्स और एक्सेसरीज़।',
    valueMr: 'ट्रक, पिकअप, टेम्पो आणि ट्रॅक्टरसाठी सजावटीच्या लाइट्स आणि अॅक्सेसरीज.',
  },
  {
    key: 'brand.phone',
    valueEn: '+91 98765 43210',
    valueHi: '+91 98765 43210',
    valueMr: '+91 98765 43210',
  },
  {
    key: 'footer.hours',
    valueEn: 'Mon-Sat, 9AM-7PM',
    valueHi: 'सोम-शनि, सुबह 9 - शाम 7',
    valueMr: 'सोम-शनि, सकाळी 9 - संध्याकाळी 7',
  },
  {
    key: 'footer.address1',
    valueEn: 'Wakad, Pune — 411057',
    valueHi: 'वाकड, पुणे — 411057',
    valueMr: 'वाकड, पुणे — 411057',
  },
  {
    key: 'footer.address2',
    valueEn: 'Maharashtra, India',
    valueHi: 'महाराष्ट्र, भारत',
    valueMr: 'महाराष्ट्र, भारत',
  },
];

async function seedSiteContent() {
  let created = 0;
  for (const item of SITE_CONTENT) {
    const existing = await prisma.siteContent.findUnique({
      where: { key: item.key },
    });
    if (existing) continue;
    await prisma.siteContent.create({ data: item });
    created += 1;
  }
  console.log(
    created > 0
      ? `✅ Seeded ${created} site content row(s).`
      : '✅ Site content already seeded. No need to seed.'
  );
}

// `node prisma/seed.js --only=content` seeds JUST the SiteContent rows —
// separate from the full `npm run seed`, which also re-seeds the demo
// product catalog (idempotent by product name: it happily re-creates any
// of the 16 demo products if they're not present under those exact names,
// e.g. because they were deliberately removed from a real dev database —
// confirmed the hard way, twice, while adding new SiteContent rows here).
// This lets a new content key be added and seeded without that side
// effect. See package.json's "seed:content" script.
const ONLY = process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1];

async function main() {
  if (ONLY === 'content') {
    await seedSiteContent();
    return;
  }
  await seedAdmin();
  await seedProducts();
  await seedSiteContent();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
