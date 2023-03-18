import os
import sys
import re

import oracledb

CURRENT_YEAR = 2023
MIN_YEAR = 2016

subject_id_regex = r"([A-Z0-9.-]+)(\[J\])?(,?)"

def normalize_subject_id(subject_id):
    """
    Normalize a subject ID by stripping leading/trailing whitespace and the "J"
    suffix for joint subjects.
    """
    return subject_id.strip().rstrip("J")

if __name__ == "__main__":
    username = os.environ.get("WAREHOUSE_USERNAME")
    password = os.environ.get("WAREHOUSE_PASSWORD")

    if username is None or password is None:
        print("WAREHOUSE_USERNAME and/or WAREHOUSE_PASSWORD not provided")
        exit(1)
    elif "/" in username:
        print("WAREHOUSE_USERNAME contains forbidden character '/'")
        exit(1)
    elif "@" in password:
        print("WAREHOUSE_PASSWORD contains forbidden character '@'")
        exit(1)

    # We need to use a DSN instead of supplying username, password, service_name
    # because we are using LDAP instead of a tsnames.ora file
    dsn = f"{username}/{password}@warehouse"

    # We also need to use the "thick" mode so that ldap.ora and sqlplus.ora are
    # read
    oracledb.init_oracle_client()

    try:
        subject = sys.argv[1]
    except IndexError:
        print(f"Usage: {sys.argv[0]} <subject>")
        exit(1)

    with oracledb.connect(dsn) as connection:
        with connection.cursor() as cursor:
            out = {}

            cursor.execute("""
                SELECT * FROM cis_course_catalog
                WHERE subject_id = :subject
                AND academic_year >= :min_year
                ORDER BY academic_year DESC
            """, subject=subject, min_year=MIN_YEAR)

            # Return results as dict
            columns = [col[0].lower() for col in cursor.description]
            cursor.rowfactory = lambda *args: dict(zip(columns, args))

            row = cursor.fetchone()

            if row is None:
                print("Subject not found")
                exit(1)

            out["subject_id"] = row["subject_id"]
            out["title"] = row["subject_title"]
            out["total_units"] = row["total_units"]
            out["offered_fall"] = row["is_offered_fall_term"] == "Y"
            out["offered_IAP"] = row["is_offered_iap"] == "Y"
            out["offered_spring"] = row["is_offered_spring_term"] == "Y"
            out["offered_summer"] = row["is_offered_summer_term"] == "Y"
            out["public"] = True
            out["level"] = row["hgn_code"]

            year = int(row["academic_year"])

            if year < CURRENT_YEAR:
                # This is considered a historical subject (for
                # compatibility with FireRoad)
                out["is_historical"] = True
                out["source_semester"] = f"spring-{year}"

            if row["joint_subjects"] is not None:
                out["joint_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["joint_subjects"].split(",")
                ]

            if row["equivalent_subjects"] is not None:
                out["equivalent_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["equivalent_subjects"].split(",")
                ]

            if row["meets_with_subjects"] is not None:
                out["meets_with_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["meets_with_subjects"].split(",")
                ]

            # TODO quarter_information (requires schedule)

            if row["is_offered_this_year"] != "Y":
                # Not offered this year
                out["not_offered_year"] = f"{year-1}-{year}"

            instructors = []
            if ((out["offered_fall"] or out["offered_summer"]) and
                    row["fall_instructors"] is not None):
                instructors.append(f"Fall: {row['fall_instructors']}")
            if ((out["offered_spring"] or out["offered_IAP"]) and
                    row["spring_instructors"] is not None):
                instructors.append(f"Spring: {row['spring_instructors']}")
            if instructors:
                out["instructors"] = instructors

            comm_req_raw = row["comm_req_attribute"]
            if comm_req_raw == "CIH":
                row["communication_requirement"] = "CI-H"
            elif comm_req_raw == "CIHW":
                row["communication_requirement"] = "CI-HW"
            # row["communication_requirement"] does not include CI-M

            out["gir_attribute"] = row["gir_attribute"]

            # TODO children, parent

            if row["status_change"] is not None:
                if "New number" in row["status_change"]:
                    print("Subject has been renumbered")
                    exit(1)

                match = re.match(
                    r"Old number:\s+(" + subject_id_regex + r")",
                    row["status_change"])
                if match:
                    out["old_id"] = normalize_subject_id(match[1])

            out["lecture_units"] = row["lecture_units"]
            out["lab_units"] = row["lab_units"]
            out["design_units"] = row["design_units"]
            out["preparation_units"] = row["preparation_units"]
            out["is_variable_units"] = row["is_variable_units"] == "Y"

            # is_half_class is not populated by the FireRoad scraper and can be
            # added via corrections

            # TODO has_final

            out["description"] = row["subject_description"]

            # TODO prerequisites/corequisites

            out["url"] = row["on_line_page_number"] + "#" + out["subject_id"]

            hass_attribute_raw = row["hass_attribute"]

            if hass_attribute_raw:
                cursor.execute("""
                    SELECT description_in_bulletin FROM cis_hass_attribute
                    WHERE hass_attribute = :hass_attribute
                """, hass_attribute=hass_attribute_raw)

                hass_res = cursor.fetchone()
                if hass_res is not None:
                    out["hass_attribute"] = hass_res[0]


            # TODO schedule

            # TODO related_subjects

            # TODO course evals

            # TODO support corrections

            for k, v in out.items():
                print(k.ljust(20) + str(v))
