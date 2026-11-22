import { LinkOpener } from '../contacts/LinkOpener';

/** Deep link https://example.org/i#… (an invitation). */
export default function InvitationLinkRoute() {
  return <LinkOpener kind="invitation" />;
}
