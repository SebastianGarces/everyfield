import 'server-only';
import { z } from 'zod';
const purpose=z.enum(['password_reset','email_verification','email_change','seat_invitation','relationship_invitation']);
// Callers select only the purpose and a server-created link, never a template body.
export function protectedTemplate(input:{purpose:z.infer<typeof purpose>;url:string},publicOrigin:string) {
  const p=purpose.parse(input.purpose),url=new URL(input.url),origin=new URL(publicOrigin);
  const paths={password_reset:'/reset-password',email_verification:'/verify-email',email_change:'/confirm-email',
    seat_invitation:'/accept-invitation',relationship_invitation:'/accept-relationship'} as const;
  if(url.origin!==origin.origin || url.pathname!==paths[p] || url.username || url.password || url.hash || !url.searchParams.get('token'))throw Error('invalid_purpose_link');
  const subjects={password_reset:'Reset your password',email_verification:'Verify your email',email_change:'Confirm your email change',
    seat_invitation:'Your EveryField invitation',relationship_invitation:'Your EveryField relationship invitation'} as const;
  return {subject:subjects[p],text:`${subjects[p]}\n\n${url.href}\n\nIf you did not request this, you can ignore this email.`};
}
