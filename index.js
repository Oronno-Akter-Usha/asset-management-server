const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const port = process.env.PORT || 5000;

// middleware
const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174"],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

// Verify Token Middleware
const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  console.log(token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err);
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.qvzse1f.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const usersCollection = client.db("assetManagement").collection("users");
    const assetsCollection = client.db("assetManagement").collection("assets");
    const requestsCollection = client
      .db("assetManagement")
      .collection("requests");

    // auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });
    // Logout
    app.get("/logout", async (req, res) => {
      try {
        res
          .clearCookie("token", {
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
          })
          .send({ success: true });
        console.log("Logout successful");
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // save a user data in db
    app.post("/user", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exits", insertedId: null });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // get a user info by email from db
    app.get("/user/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    // get a employee-without-company
    app.get("/employees-without-company", async (req, res) => {
      const employees = await usersCollection
        .find({ role: "employee", company_name: "" })
        .toArray();
      res.send(employees);
    });

    // API to add an employee to an HR Manager's team with validation and updates.
    app.patch("/add-employee", async (req, res) => {
      const { hrEmail, employeeId } = req.body;

      // Fetch the HR manager's details using hrEmail
      const hr = await usersCollection.findOne({
        email: hrEmail,
        role: "hrManager",
      });
      console.log("HR found:", hr);

      if (!hr) {
        return res.send({ message: "HR Manager not found." });
      }

      // Check if the team size exceeds the package limit
      if (hr.team.length >= hr.package.memberLimit) {
        return res.send({ message: "Team member limit exceeded." });
      }

      // Add the employee to the HR's team
      const result = await usersCollection.updateOne(
        { email: hrEmail },
        { $addToSet: { team: new ObjectId(String(employeeId)) } }
      );

      // Update the employee's `company_name` field
      const updateEmployee = await usersCollection.updateOne(
        { _id: new ObjectId(String(employeeId)) },
        {
          $set: {
            company_name: hr.company_name,
            added_by_hrManager: hrEmail,
          },
        }
      );

      res.send(result);
    });

    // get my employee for hr
    app.get("/myEmployee", async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res.send({ message: "HR email is required." });
      }
      // Fetch HR Manager details
      const hr = await usersCollection.findOne({ email, role: "hrManager" });

      if (!hr) {
        return res.send({ message: "HR Manager not found." });
      }

      // Fetch HR Manager's team members
      const teamDetails = await usersCollection
        .find({ added_by_hrManager: email })
        .toArray();

      // Include HR Manager as the first entry
      const fullTeam = [{ ...hr, isHR: true }, ...teamDetails];

      return res.send({ team: fullTeam });
    });

    // get my team for employees
    app.get("/myTeam", async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res.send({ message: "Employee email is required." });
      }

      // Fetch the employee's HR Manager
      const employee = await usersCollection.findOne(
        { email, role: "employee" },
        { projection: { added_by_hrManager: 1 } }
      );

      if (!employee || !employee.added_by_hrManager) {
        return res.send({ message: "HR Manager not found for this employee." });
      }

      const hrEmail = employee.added_by_hrManager;
      const hr = await usersCollection.findOne({
        email: hrEmail,
        role: "hrManager",
      });

      if (!hr) {
        return res.send({ message: "HR Manager details not found." });
      }

      // Fetch the HR Manager's team members
      const teamMembers = await usersCollection
        .find({ added_by_hrManager: hrEmail })
        .toArray();

      // Combine HR Manager and team members into a single team array
      const team = [{ ...hr, isHR: true }, ...teamMembers];
      return res.send({ team });
    });

    // remove any employee from team
    app.delete("/team/:employeeId", async (req, res) => {
      const { employeeId } = req.params;
      const { hrEmail } = req.body; // Extract hrEmail from the request body

      if (!ObjectId.isValid(employeeId)) {
        return res.send({ message: "Invalid employee ID." });
      }

      // Find HR Manager by email
      const hr = await usersCollection.findOne({
        email: hrEmail,
        role: "hrManager",
      });

      if (!hr) {
        return res.send({ message: "HR Manager not found." });
      }

      // Remove the employee ID from HR manager's team
      const updatedTeam = hr.team.filter(
        (teamMemberId) => teamMemberId.toString() !== employeeId
      );

      // Update the HR manager's document to reflect the change
      await usersCollection.updateOne(
        { email: hrEmail, role: "hrManager" },
        { $set: { team: updatedTeam } }
      );

      // Clear company_name and added_by_hrManager fields from employee document
      const updateResult = await usersCollection.updateOne(
        { _id: new ObjectId(employeeId) }, // Correctly instantiate ObjectId using 'new'
        { $set: { company_name: "", added_by_hrManager: "" } }
      );

      // Check if the update was successful
      if (updateResult.modifiedCount === 0) {
        return res.send({ message: "Employee fields not updated." });
      }

      res.send({
        message: "Employee removed from the team and fields cleared.",
      });
    });

    // Add a new asset to the assets collection.
    app.post("/asset", async (req, res) => {
      const asset = req.body;
      const result = await assetsCollection.insertOne(asset);
      res.send(result);
    });

    // Retrieves assets added by a specific HR Manager using their email.
    app.get("/assets/:email", async (req, res) => {
      const hrEmail = req.params.email;
      const result = await assetsCollection
        .find({ added_by_hrManager: hrEmail })
        .toArray();
      res.send(result);
    });

    // Deletes a specific asset by its ID.
    app.delete("/asset/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await assetsCollection.deleteOne(query);
      res.send(result);
    });

    // get assets for empolyee
    app.get("/assets", async (req, res) => {
      const { search, availability, type, userEmail } = req.query;

      if (!userEmail) {
        return res.send({ message: "User email is required" });
      }

      // Find the employee
      const employee = await usersCollection.findOne({ email: userEmail });
      if (!employee || !employee.added_by_hrManager) {
        return res.send({ message: "No associated HR manager found" });
      }

      const hrEmail = employee.added_by_hrManager;

      // Query to filter assets
      const query = { added_by_hrManager: hrEmail };

      if (search) {
        query.name = { $regex: search, $options: "i" };
      }

      if (availability) {
        query.quantity =
          availability === "available" ? { $gt: 0 } : { $lte: 0 };
      }

      if (type) {
        query.product_type = type;
      }

      const assets = await assetsCollection.find(query).toArray();
      res.send(assets);
    });

    // save the request in the database.
    app.post("/request", async (req, res) => {
      const request = req.body;
      const result = await requestsCollection.insertOne(request);
      res.send(result);
    });

    // Fetch requested assets by the logged-in user with search and filter
    app.get("/requested-assets/:email", async (req, res) => {
      const { search, availability, type } = req.query;
      const userEmail = req.params.email;

      if (!userEmail) {
        return res.status(400).send({ error: "User email is required" });
      }

      const query = { requestedBy: userEmail };

      // Apply filters
      if (search) {
        if (!query.asset) query.asset = {};
        query.asset.name = { $regex: search, $options: "i" };
      }
      if (availability) {
        if (!query.asset) query.asset = {};
        query.asset.quantity =
          availability === "available" ? { $gt: 0 } : { $lte: 0 };
      }
      if (type) {
        if (!query.asset) query.asset = {};
        query.asset.product_type = type;
      }

      console.log("Query:", query);

      const assets = await requestsCollection
        .find(query)
        .sort({ requestDate: -1 })
        .toArray();

      console.log("Assets Found:", assets);

      if (!assets.length) {
        return res.status(404).send({ message: "No assets found." });
      }

      res.send(assets);
    });

    // Cancel a request
    app.patch("/cancel-request/:id", async (req, res) => {
      const id = req.params.id;
      const result = await requestsCollection.updateOne(
        { _id: new ObjectId(id) }, // Ensure the ID is an ObjectId
        { $set: { status: "Cancelled" } }
      );
      res.send(result);
    });
    // Return an asset
    app.patch("/return-asset/:id", async (req, res) => {
      const id = req.params.id;

      // Find the asset request by ID
      const assetRequest = await requestsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (
        assetRequest?.asset?.product_type === "Returnable" &&
        assetRequest?.status === "Approved"
      ) {
        // Update the request status to "Returned"
        const updateResult = await requestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "Returned" } }
        );

        // Increment the asset quantity in the assets collection
        const quantityUpdate = await assetsCollection.updateOne(
          { _id: new ObjectId(String(assetRequest.asset._id)) },
          { $inc: { quantity: 1 } }
        );

        if (
          updateResult.modifiedCount === 1 &&
          quantityUpdate.modifiedCount === 1
        ) {
          res.send({ success: true, message: "Asset returned successfully." });
        } else {
          res.send({ success: false, message: "Failed to return asset." });
        }
      } else {
        res.send({
          success: false,
          message: "Invalid request or asset is not returnable.",
        });
      }
    });

    // get home page data for employees
    app.get("/home-employee/:email", async (req, res) => {
      const email = req.params.email;
      if (!email) {
        return res.send({ message: "User email is required" });
      }

      const pendingRequests = await requestsCollection
        .find({ requestedBy: email, status: "Pending" })
        .sort({ requestDate: -1 })
        .toArray();

      const monthlyRequests = await requestsCollection
        .find({
          requestedBy: email,
        })
        .sort({ request_date: -1 })
        .toArray();

      console.log("Monthly requests:", monthlyRequests);

      if (monthlyRequests.length === 0) {
        console.log("No monthly requests found");
      }

      res.send({
        pendingRequests,
        monthlyRequests,
      });
    });

    // Ensure proper connection to the database before starting the server
    await client.connect();
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  } catch (err) {
    console.error(
      "Error connecting to the database or starting the server:",
      err
    );
  }
}

run().catch(console.dir);
