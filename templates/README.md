# Upload templates

- `pilot-upload-template.csv`: blank template for practices. Column names are suggestions; the upload screen lets staff map any EHR export to our fields. "Your Result:" columns are the pilot answer key (what the practice's own team found) and are optional.
- `sample-ehr-export.csv`: test file using Stedi's mock patients, with EHR-style headers ("Pt DOB", "Ins Member #") to exercise column mapping. Includes rows that should be rejected (bad DOB, unknown payer) and skipped (cash). **No real patient data.**
- `sample-raw-ehr-export.csv`: a raw export with the column names Nick shared (no member ID, no NPI, billing columns, two insurance columns). Tests mapping, file-wide defaults, payer-name lookup and the "no member ID" warning. Test patients only.
- `jeff-sample-set.csv`: the test set for the SOP walkthrough. Same headers as the raw EHR export plus Member ID, Group Number and "Verified …" columns (the clinic's own results, mapped under "Your team's results"). Stedi mock patients + one inactive + one self-pay. **No real patient data.**
