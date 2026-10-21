import { PhotoLayer, type Layer } from "./Backdrop";
import { HERO_AVIF } from "./hero-photos.generated";
import { PHOTOS, type HeroPhoto } from "./photos";

/**
 * The page's hero photo, the LCP element: a 480 px AVIF inlined in the page (scripts/render-hero-photos.mjs), so it needs
 * no request of its own, with a 640 px JPEG for browsers without AVIF. A server component: the data stays out of the
 * client bundles.
 */
export function HeroBackdrop({ photo, ...layer }: Layer & { photo: HeroPhoto }) {
	const crop = PHOTOS[photo];
	return (
		<PhotoLayer {...layer} pos={crop.pos}>
			<source type="image/avif" srcSet={HERO_AVIF[photo]} />
			{/* eslint-disable-next-line @next/next/no-img-element -- the <picture> is in PhotoLayer; the photo is inlined */}
			<img src={`/photos/${photo}-640.jpg`} alt="" fetchPriority="high" />
		</PhotoLayer>
	);
}
