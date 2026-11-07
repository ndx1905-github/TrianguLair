import { LinkOpener } from '../contacts/LinkOpener';

/** Deep link https://triangulair.app/i#… (an invitation). */
export default function InvitationLinkRoute() {
  return <LinkOpener kind="invitation" />;
}
