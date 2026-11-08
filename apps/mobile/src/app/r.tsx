import { LinkOpener } from '../contacts/LinkOpener';

/** Deep link https://triangulair.app/r#… (a return link, the answer to one of my invitations). */
export default function ReturnLinkRoute() {
  return <LinkOpener kind="return" />;
}
