import "server-only";
export { accountPersonProducer, peopleWriter } from "./people.ts";
export { getAccountLink, peopleReader, peopleViewer, readPeopleViewer } from "./queries.ts";
export { detachAccountPersonLinks } from "./references.ts";

export { PeopleReadContext, withPeopleWrite } from "./core.ts";
