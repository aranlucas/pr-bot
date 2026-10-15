import { eveChannel } from 'eve/channels/eve';
// Disable interactive access: only the signed webhook channel can start work.
export default eveChannel({ auth: [] });
