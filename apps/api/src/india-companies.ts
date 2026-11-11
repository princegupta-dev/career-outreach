import type { DefaultSource } from './providers/jobs/default-sources';
import { domainOf, resolveBoards, YcCompany } from './startups';

/**
 * Indian product companies that hire backend engineers. Their job boards (Greenhouse / Ashby / Lever) are found
 * and verified at run time, on your machine, then cached for 14 days. A company whose careers page runs on
 * something else (Darwinbox, Keka, a custom site) simply finds no board and is skipped.
 * To add a company: append [name, website].
 */
export const INDIA_COMPANIES: Array<[string, string]> = [
  ['CRED', 'https://cred.club'], ['Meesho', 'https://meesho.com'], ['PhonePe', 'https://phonepe.com'], ['Swiggy', 'https://swiggy.com'],
  ['Zepto', 'https://zeptonow.com'], ['Postman', 'https://postman.com'], ['BrowserStack', 'https://browserstack.com'], ['Zeta', 'https://zeta.tech'],
  ['Jupiter', 'https://jupiter.money'], ['Fi', 'https://fi.money'], ['Paytm', 'https://paytm.com'], ['Upstox', 'https://upstox.com'],
  ['Zerodha', 'https://zerodha.com'], ['Navi', 'https://navi.com'], ['smallcase', 'https://smallcase.com'], ['Khatabook', 'https://khatabook.com'],
  ['Urban Company', 'https://urbancompany.com'], ['Nykaa', 'https://nykaa.com'], ['Lenskart', 'https://lenskart.com'], ['CARS24', 'https://cars24.com'],
  ['Spinny', 'https://spinny.com'], ['Dream11', 'https://dream11.com'], ['ShareChat', 'https://sharechat.com'], ['Unacademy', 'https://unacademy.com'],
  ['Physics Wallah', 'https://pw.live'], ['Scaler', 'https://scaler.com'], ['Delhivery', 'https://delhivery.com'], ['Shiprocket', 'https://shiprocket.in'],
  ['Porter', 'https://porter.in'], ['Rapido', 'https://rapido.bike'], ['Ather Energy', 'https://atherenergy.com'], ['Freshworks', 'https://freshworks.com'],
  ['Chargebee', 'https://chargebee.com'], ['CleverTap', 'https://clevertap.com'], ['MoEngage', 'https://moengage.com'], ['WebEngage', 'https://webengage.com'],
  ['Mindtickle', 'https://mindtickle.com'], ['Whatfix', 'https://whatfix.com'], ['LeadSquared', 'https://leadsquared.com'], ['Darwinbox', 'https://darwinbox.com'],
  ['Innovaccer', 'https://innovaccer.com'], ['Sprinklr', 'https://sprinklr.com'], ['Yellow.ai', 'https://yellow.ai'], ['Gupshup', 'https://gupshup.io'],
  ['Exotel', 'https://exotel.com'], ['Juspay', 'https://juspay.in'], ['Setu', 'https://setu.co'], ['Perfios', 'https://perfios.com'],
  ['HyperVerge', 'https://hyperverge.co'], ['Cashfree Payments', 'https://cashfree.com'], ['INDmoney', 'https://indmoney.com'], ['CoinDCX', 'https://coindcx.com'],
  ['Hasura', 'https://hasura.io'], ['Appsmith', 'https://appsmith.com'], ['Rocketlane', 'https://rocketlane.com'], ['LambdaTest', 'https://lambdatest.com'],
  ['Uniphore', 'https://uniphore.com'], ['Eightfold AI', 'https://eightfold.ai'], ['Zluri', 'https://zluri.com'], ['Amagi', 'https://amagi.com'],
  ['Jar', 'https://myjar.app'], ['Plum', 'https://plumhq.com'], ['Pocket FM', 'https://pocketfm.com'], ['apna', 'https://apna.co'],
  ['Acko', 'https://acko.com'], ['PolicyBazaar', 'https://policybazaar.com'], ['OYO', 'https://oyorooms.com'], ['MakeMyTrip', 'https://makemytrip.com'],
  ['ixigo', 'https://ixigo.com'], ['Licious', 'https://licious.in'], ['Udaan', 'https://udaan.com'], ['Moglix', 'https://moglix.com'],
  ['Zetwerk', 'https://zetwerk.com'], ['OfBusiness', 'https://ofbusiness.com'], ['NoBroker', 'https://nobroker.in'], ['Livspace', 'https://livspace.com'],
  ['Simpl', 'https://getsimpl.com'], ['BharatPe', 'https://bharatpe.com'], ['Pine Labs', 'https://pinelabs.com'], ['PayU', 'https://payu.in'],
  ['MobiKwik', 'https://mobikwik.com'], ['KreditBee', 'https://kreditbee.in'], ['Money View', 'https://moneyview.in'], ['Rupeek', 'https://rupeek.com'],
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** As directory entries, so the startup board finder can be reused. Keys are prefixed so they never clash with YC ids. */
export const indiaCompanies = (list = INDIA_COMPANIES): YcCompany[] => list.map(([name, website]) => ({ id: `in:${slug(name)}`, name, slug: slug(name), website }));

export async function indiaCompanySources(opts: { concurrency?: number; now?: Date } = {}): Promise<{ sources: DefaultSource[]; warnings: string[] }> {
  const companies = indiaCompanies();
  const { boards, unreachable } = await resolveBoards(companies, opts);
  const sources: DefaultSource[] = companies.flatMap((c) => {
    const b = boards.get(String(c.id));
    return b ? [{ provider: b.ats, name: c.name, config: { boardToken: b.slug, companyName: c.name, domain: domainOf(c.website) ?? undefined } }] : [];
  });
  return { sources, warnings: unreachable ? [`${unreachable} Indian companies could not be checked (network errors); retried next search`] : [] };
}
