// content service — admin-editable, trilingual storefront text (see
// prisma/schema.prisma's SiteContent model for why this exists).
const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');

exports.getAllContent = () =>
  prisma.siteContent.findMany({ orderBy: { key: 'asc' } });

/**
 * Creates the row if `key` doesn't exist yet, otherwise updates it — an
 * admin editing a not-yet-seeded key (e.g. a new category label added
 * later) just works, same as editing an existing one.
 */
exports.upsertContent = async (key, { valueEn, valueHi, valueMr }) => {
  if (!valueEn || !valueHi || !valueMr) {
    // All three or none — a key half-translated (present in English, blank
    // in Hindi) would silently fall back to a stale/wrong value for
    // whichever language the storefront reader has selected, with no
    // signal to the admin that they left a language out.
    throw new CustomError(
      'valueEn, valueHi and valueMr are all required',
      400
    );
  }

  return prisma.siteContent.upsert({
    where: { key },
    update: { valueEn, valueHi, valueMr },
    create: { key, valueEn, valueHi, valueMr },
  });
};
