# Upload templates

- `pilot-upload-template.csv`: blank template for practices. Column names are suggestions; the upload screen lets staff map any EHR export to our fields. "Your Result:" columns are the pilot answer key (what the practice's own team found) and are optional.
- `sample-ehr-export.csv`: test file using Stedi's mock patients, with EHR-style headers ("Pt DOB", "Ins Member #") to exercise column mapping. Includes rows that should be rejected (bad DOB, unknown payer) and skipped (cash). **No real patient data.**
