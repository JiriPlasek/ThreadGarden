/** How a message's images are named where they aren't shown: "1 image", "3 images". */
export const imageCountText = (n: number): string => (n === 1 ? '1 image' : `${n} images`);
