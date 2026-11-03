/**
 * Colour ramps for the cube, 256 steps, from matplotlib. Fixed, not a user choice
 * (user, 2026-10-30):
 * - heights (RH mode, canopy height): inferno, the VSM height-map convention;
 * - energy: YlGn, light at the low end — nearly every voxel holds a few percent,
 *   and on inferno those are near-black, which hid the shape of the canopy.
 */

const decode = (hex: string) => Uint8Array.from({ length: 256 * 3 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));

/** matplotlib YlGn, [r, g, b] * 256, 0-255. */
export const ENERGY_LUT = decode(
  'ffffe5ffffe4feffe2feffe1feffdffeffdefdfeddfdfedbfdfedafdfed9fcfed7fcfed6fcfed4fcfed3fbfed2fbfed0' +
  'fbfdcffbfdcefafdccfafdcbfafdc9fafdc8f9fdc7f9fdc5f9fdc4f9fdc2f8fdc1f8fcc0f8fcbef8fcbdf7fcbcf7fcba' +
  'f7fcb9f6fcb8f5fbb8f4fbb7f3fab6f2fab5f1fab5f0f9b4eff9b3eef9b3edf8b2edf8b1ecf7b1ebf7b0eaf7afe9f6af' +
  'e8f6aee7f6ade6f5ace5f5ace4f4abe3f4aae2f4aae1f3a9e0f3a8dff3a8def2a7ddf2a6ddf1a6dcf1a5dbf1a4daf0a4' +
  'd9f0a3d7efa2d6efa2d5eea1d3eda0d2eda0d0ec9fcfec9eceeb9eccea9dcbea9cc9e99cc8e99bc7e89ac5e89ac4e799' +
  'c3e698c1e698c0e597bee596bde496bce395bae394b9e294b8e293b6e192b5e092b3e091b2df90b1df90afde8faedd8e' +
  'acdd8eabdc8da9db8ca7db8ca6da8ba4d98aa2d88aa1d8899fd7889dd6889cd6879ad58798d48697d38595d38593d284' +
  '92d18390d0838ed0828dcf818bce8189ce8088cd7f86cc7f84cb7e83cb7d81ca7d7fc97c7ec97b7cc87b7ac77a79c679' +
  '77c67975c57874c47772c37670c2756fc1746dc0736bc07269bf7268be7166bd7064bc6f62bb6e61bb6d5fba6c5db96b' +
  '5cb86b5ab76a58b66956b56855b56753b46651b3654fb2644eb1634cb0634ab06249af6147ae6045ad5f43ac5e42ab5d' +
  '40aa5c3fa95c3fa85b3ea75a3da5593ca4583ba3583aa25739a056389f55379e54369d54359c53349a52339951329850' +
  '31974f30954f2f944e2f934d2e924c2d914b2c8f4b2b8e4a2a8d49298c48288a47278946268846258745248644238443' +
  '2283432182422082421f81421e80411d7f411c7e401a7d40197c40187b3f177b3f167a3f15793e14783e13773d12763d' +
  '11753d10743c0e743c0d733c0c723b0b713b0a703a096f3a086e3a076d39066d39056c39036b38026a38016937006837' +
  '006737006636006536006435006335006234006034005f34005e33005d33005c32005b32005a31005931005830005730' +
  '00553000542f00532f00522e00512e00502d004f2d004e2d004d2c004c2c004a2b00492b00482a00472a004629004529',
);

/** CSS gradient of a ramp, for legends. */
export function cssGradient(lut: Uint8Array): string {
  const stops = Array.from({ length: 9 }, (_, i) => {
    const k = Math.round((i / 8) * 255) * 3;
    return `rgb(${lut[k]}, ${lut[k + 1]}, ${lut[k + 2]})`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
