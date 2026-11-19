import { identityHandler, identityWrite } from "@/server/identity";
export const maxDuration = 30;
export {
	identityWrite as DELETE,
	identityHandler as GET,
	identityHandler as HEAD,
	identityHandler as OPTIONS,
	identityWrite as PATCH,
	identityWrite as POST,
	identityWrite as PUT,
};
